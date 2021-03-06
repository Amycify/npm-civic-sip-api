"use strict";

require("babel-polyfill");

const stringify = require('json-stringify');
const uritemplate = require('./lib/url-template/url-template');
const apiGateway = require('./lib/apiGatewayCore/apiGatewayClient');
const basicCrypto = require('./lib/basicCrypto');
const jwtjs = require('./lib/jwt');

const sipClientFactory = {};

const JWT_EXPIRATION = '3m';

sipClientFactory.newClient = function (config) {

  const hostedServices = {
    SIPHostedService: {
      base_url: 'https://api.civic.com/sip/',
      hexpub: '049a45998638cfb3c4b211d72030d9ae8329a242db63bfb0076a54e7647370a8ac5708b57af6065805d5a6be72332620932dbb35e8d318fce18e7c980a0eb26aa1',
      tokenType: 'JWT'
    },
  }

  const apigClient = { };
  if(config === undefined) {
      config = {
          appId: '',
          appSecret: '',  // hex format
          prvKey: '',     // hex format
          env: 'prod',
          defaultContentType: 'application/json',
          defaultAcceptType: 'application/json'
      };
  }

  if(!config.appId) {
      throw new Error('Please supply your application ID.');
  }

  if(!config.appSecret) {
    throw new Error('Please supply your application secret.');
  }

  if(!config.prvKey) {
    throw new Error('Please supply your application private key.');
  }

  if(!config.env) {
    config.env = 'prod';
  }

  if (config.api) {
    hostedServices.SIPHostedService.base_url = config.api;

    if (!config.api.endsWith('/')) {
      hostedServices.SIPHostedService.base_url += '/';
    }
  }

  //If defaultContentType is not defined then default to application/json
  if(config.defaultContentType === undefined) {
      config.defaultContentType = 'application/json';
  }
  //If defaultAcceptType is not defined then default to application/json
  if(config.defaultAcceptType === undefined) {
      config.defaultAcceptType = 'application/json';
  }

  // extract endpoint and path from url
  const invokeUrl = hostedServices.SIPHostedService.base_url + config.env;
  const endpoint = /(^https?:\/\/[^\/]+)/g.exec(invokeUrl)[1];
  const pathComponent = invokeUrl.substring(endpoint.length);

  const sigV4ClientConfig = {
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      sessionToken: config.sessionToken,
      serviceName: 'execute-api',
      region: config.region,
      endpoint: endpoint,
      defaultContentType: config.defaultContentType,
      defaultAcceptType: config.defaultAcceptType
  };

  let authType = 'NONE';
  if (sigV4ClientConfig.accessKey !== undefined && sigV4ClientConfig.accessKey !== '' && sigV4ClientConfig.secretKey !== undefined && sigV4ClientConfig.secretKey !== '') {
      authType = 'AWS_IAM';
  }

  const simpleHttpClientConfig = {
      endpoint: endpoint,
      defaultContentType: config.defaultContentType,
      defaultAcceptType: config.defaultAcceptType
  };

  const apiGatewayClient = apiGateway.core.apiGatewayClientFactory.newClient(simpleHttpClientConfig, sigV4ClientConfig);

  /**
   * Creates the authorization header as an extended Civic JWT Token.
   * The token format: Civic requestToken.extToken
   * where requestToken certifies the service path, method
   * and audience, and extToken certifies the request body.
   *
   * The token is signed by the application secret.
   *
   * @param targetPath
   * @param targetMethod
   * @param requestBody
   * @returns {string}
   */
  function makeAuthorizationHeader(targetPath, targetMethod, requestBody) {
    const jwtToken = jwtjs.createToken(config.appId, hostedServices['SIPHostedService'].base_url, config.appId, JWT_EXPIRATION, {
      method: targetMethod,
      path: targetPath
    }, config.prvKey);

    const extension = jwtjs.createCivicExt(requestBody, config.appSecret);
    return 'Civic' + ' ' + jwtToken + '.' + extension;
  }

  /**
   * The user data received from the civic sip server is wrapped in a
   * JWT token and encrypted using aes with the partner secret. This
   * function verifies the token is valid (signed by Civic sip server etc.)
   * and decrypts the user data if required.
   *
   * @param payload contains data field with JWT token signed by sip-hosted-services
   */
  function verifyAndDecrypt(payload) {
    const token = payload.data;
    const isValid = jwtjs.verify(token, hostedServices.SIPHostedService.hexpub, { gracePeriod: 60, });

    if (!isValid) {
      throw new Error('JWT Token containing encrypted data could not be verified');
    }

    // decrypt the data
    const decodedToken = jwtjs.decode(token);
    let userData,
        clearText = decodedToken.payloadObj.data;

    if (payload.encrypted) {
      clearText = basicCrypto.decrypt(decodedToken.payloadObj.data, config.appSecret);
    }

    return clearText;
  }
  /**
   * Exchange authorization code in the form of a JWT Token for the user data
   * requested in the scope request.
   *
   * @param jwtToken containing the authorization code
   *
   */

  async function exchangeCode(jwtToken) {
    const body = { authToken: jwtToken };
    const authHeader = makeAuthorizationHeader('scopeRequest/authCode', 'POST', body);
    const contentLength = Buffer.byteLength(JSON.stringify(body));
    const additionalParams = {
      // If there are any unmodeled query parameters or headers that must be
      //   sent with the request, add them here.
      headers: {
        'Content-Length': contentLength,
        'Accept': '*/*',
        'Authorization': authHeader,
      },
      queryParams: {
      }
    };
    const params = {};

    const scopeRequestAuthCodePostRequest = {
        verb: 'post'.toUpperCase(),
        path: pathComponent + uritemplate('/scopeRequest/authCode').expand(apiGateway.core.utils.parseParametersToObject(params, [])),
        headers: apiGateway.core.utils.parseParametersToObject(params, []),
        queryParams: apiGateway.core.utils.parseParametersToObject(params, []),
        body: body
    };

    let data, errorObj;

    try {

      const response = await apiGatewayClient.makeRequest(scopeRequestAuthCodePostRequest, authType, additionalParams);
      // console.log('Civic response: ', JSON.stringify(response, null, 2));
      if (response.status != 200) {
        errorObj = new Error('Error exchanging code for data: ' , response.status);
      } else {
        return verifyAndDecrypt(response.data);
      }

    } catch(error) {
      // console.log('Civic ERROR response: ', JSON.stringify(error, null, 2));
      errorObj =  new Error('Error exchanging code for data: ' + error.data && error.data.message);
    }

    if (errorObj) {
      throw errorObj;
    }

  };

  apigClient.exchangeCode = exchangeCode;
  apigClient.verifyAndDecrypt = verifyAndDecrypt;

  return apigClient;
};

module.exports = sipClientFactory;
