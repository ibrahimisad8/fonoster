/*
 * Copyright (C) 2021 by Fonoster Inc (https://fonoster.com)
 * http://github.com/fonoster/fonos
 *
 * This file is part of Project Fonos
 *
 * Licensed under the MIT License (the "License");
 * you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 *    https://opensource.org/licenses/MIT
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import grpc, {ServerWritableStream} from "grpc";
import {Empty} from "./protos/common_pb";
import {IFuncsServer} from "./protos/funcs_grpc_pb";
import {
  CreateRegistryTokenRequest,
  CreateRegistryTokenResponse,
  DeployFuncRequest,
  DeployStream,
  DeleteFuncRequest,
  Func,
  FuncLog,
  GetFuncLogsRequest,
  GetFuncRequest,
  ListFuncsRequest,
  ListFuncsResponse
} from "./protos/funcs_pb";
import {HttpBasicAuth, DefaultApi as FaaS} from "openfaas-client";
import logger from "@fonos/logger";
import {ErrorCodes, FonosError, FonosSubsysUnavailable} from "@fonos/errors";
import {getAccessKeyId} from "@fonos/core";
import axios from "axios";
import {
  rawFuncToFunc,
  getFuncName,
  buildFaasCreateParameters,
  getImageName,
  getBuildDir,
  assertValidFuncName
} from "../utils";
import buildAndPublishImage from "./registry";
import btoa from "btoa";
const {promisify} = require("util");
const sleep = promisify(setTimeout);

// Initializing access info for FaaS
const faas = new FaaS();
const auth = new HttpBasicAuth();
auth.username = process.env.FUNCS_USERNAME;
auth.password = process.env.FUNCS_SECRET;
faas.setDefaultAuthentication(auth);
faas.basePath = process.env.FUNCS_URL;

export class ServerStream {
  call: any;
  constructor(call) {
    this.call = call;
  }

  write(message: string) {
    const msg = new DeployStream();
    msg.setText(message);
    this.call.write(msg);
  }
}

const publish = async (
  call: grpc.ServerUnaryCall<DeployFuncRequest>,
  serverStream: ServerStream
) => {
  const accessKeyId = getAccessKeyId(call);
  const parameters = buildFaasCreateParameters({
    request: call.request,
    accessKeyId: accessKeyId,
    jwtSignature: ""
  });

  await buildAndPublishImage(
    {
      baseImage: call.request.getBaseImage(),
      registry: process.env.DOCKER_REGISTRY,
      image: parameters.image,
      pathToFunc: getBuildDir(accessKeyId, call.request.getName()),
      username: process.env.DOCKER_REGISTRY_USERNAME,
      secret: process.env.DOCKER_REGISTRY_SECRET
    },
    serverStream
  );

  logger.verbose("@fonos/funcs publish [publishing to funcs subsystem]");

  const attempts = [1, 2, 3];
  let index;
  for (index in attempts) {
    // Sometime the image is not inmediatly available so we try a few times
    logger.verbose(
      `@fonos/funcs publish [publishing to functions subsystem (try #${attempts[index]})`
    );
    serverStream.write(
      `publishing to functions subsystem (try #${attempts[index]})`
    );
    await sleep(20000);
    try {
      // If the function already exist this will fail
      logger.verbose(`@fonos/funcs publish [first trying post]`);
      await faas.systemFunctionsPost(parameters);
      break;
    } catch (e) {
      logger.verbose(`@fonos/funcs publish [now trying trying put]`);
      try {
        await faas.systemFunctionsPut(parameters);
        break;
      } catch (e) {}
    }
  }

  return parameters;
};

export default class FuncsServer implements IFuncsServer {
  getFuncLogs: grpc.handleServerStreamingCall<GetFuncLogsRequest, FuncLog>;

  // See client-side for comments
  async listFuncs(
    call: grpc.ServerUnaryCall<ListFuncsRequest>,
    callback: grpc.sendUnaryData<ListFuncsResponse>
  ) {
    try {
      if (!call.request.getPageToken()) callback(null, new ListFuncsResponse());
      const accessKeyId = getAccessKeyId(call);
      const list = (await faas.systemFunctionsGet()).response.body;
      const rawFuncs = list.filter(
        (f) => f.envVars.ACCESS_KEY_ID === accessKeyId
      );

      const funcs = rawFuncs.map((f) => rawFuncToFunc(f));
      const response = new ListFuncsResponse();
      response.setFuncsList(funcs);
      // No pagination need because the list of function is likely to be short
      // response.setNextPageToken()
      callback(null, response);
    } catch (e) {
      logger.error(`@fonos/funcs list [${e}]`);
    }
  }

  // See client-side for comments
  async getFunc(
    call: grpc.ServerUnaryCall<GetFuncRequest>,
    callback: grpc.sendUnaryData<Func>
  ) {
    try {
      const list = (await faas.systemFunctionsGet()).response.body;
      const accessKeyId = getAccessKeyId(call);
      const rawFunction: Func = list.filter(
        (f) => f.name === getFuncName(accessKeyId, call.request.getName())
      )[0];

      if (!rawFunction)
        throw new FonosError(
          `function name "${call.request.getName()}" doesn't exist`,
          ErrorCodes.NOT_FOUND
        );

      callback(null, rawFuncToFunc(rawFunction));
    } catch (e) {
      logger.error(`@fonos/funcs get [${e}]`);
      callback(e, null);
    }
  }

  // See client-side for comments
  // TODO: Resign with JWT token
  async deployFunc(
    call: ServerWritableStream<DeployFuncRequest, DeployStream>
  ) {
    try {
      assertValidFuncName(call.request.getName());
      const serverStream = new ServerStream(call);
      serverStream.write("starting function deployment");
      await publish(call, serverStream);
      serverStream.write("deployment complete");
      serverStream.write("your function will be available shortly");
      call.end();
    } catch (e) {
      logger.error(`@fonos/funcs deploy [${e}]`);
      if (e.response.statusCode === 400) {
        call.emit(
          "error",
          new FonosError(e.response.body, ErrorCodes.INVALID_ARGUMENT)
        );
      } else if (e.response.statusCode === 401) {
        call.emit(
          "error",
          new FonosSubsysUnavailable("Functions subsystem unavailable")
        );
      } else if (e.response.statusCode === 404) {
        call.emit(
          "error",
          new FonosError(e.response.body, ErrorCodes.NOT_FOUND)
        );
      }
      call.emit("error", new FonosError(e, ErrorCodes.NOT_FOUND));
    }
  }

  // See client-side for comments
  async deleteFunc(
    call: grpc.ServerUnaryCall<DeleteFuncRequest>,
    callback: grpc.sendUnaryData<Empty>
  ) {
    const accessKeyId = getAccessKeyId(call);
    const functionName = getFuncName(accessKeyId, call.request.getName());
    try {
      await faas.systemFunctionsDelete({functionName});
      callback(null, new Empty());
    } catch (e) {
      logger.error(`@fonos/funcs delete [${e}]`);
      if (e.response.statusCode === 404) {
        callback(
          new FonosError(
            `Function name "${call.request.getName()}" doesn't exist`,
            ErrorCodes.NOT_FOUND
          ),
          null
        );
      }
      callback(e, null);
    }
  }

  /**
   * @deprecated
   *
   * This function creates a single use, scoped token, useful for pushing images
   * to a private Docker registry.
   */
  async createRegistryToken(
    call: grpc.ServerUnaryCall<CreateRegistryTokenRequest>,
    callback: grpc.sendUnaryData<CreateRegistryTokenResponse>
  ) {
    try {
      if (!call.request.getFuncName())
        throw new FonosError(
          "Missing function name",
          ErrorCodes.INVALID_ARGUMENT
        );
      const endpoint = process.env.DOCKER_REGISTRY_AUTH_ENDPOINT;
      const service = process.env.DOCKER_REGISTRY_SERVICE;
      const auth = btoa(
        `${process.env.DOCKER_REGISTRY_USERNAME}:${process.env.DOCKER_REGISTRY_SECRET}`
      );
      const image = getImageName();
      const baseURL = `${endpoint}?service=${service}&scope=repository:${image}:push`;
      const result = await axios
        .create({
          headers: {Authorization: `Basic ${auth}`}
        })
        .get(baseURL);
      const token = result.data.token;
      const res = new CreateRegistryTokenResponse();
      res.setToken(token);
      res.setImage(image);
      callback(null, res);
    } catch (e) {
      callback(new FonosError(e), null);
    }
  }
}
