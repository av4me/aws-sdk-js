/**
 * Copyright 2012-2013 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"). You
 * may not use this file except in compliance with the License. A copy of
 * the License is located at
 *
 *     http://aws.amazon.com/apache2.0/
 *
 * or in the "license" file accompanying this file. This file is
 * distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
 * ANY KIND, either express or implied. See the License for the specific
 * language governing permissions and limitations under the License.
 */

var AWS = require('./core');
require('./event_listeners');
var inherit = AWS.util.inherit;

/**
 * @api private
 */
AWS.Client = inherit({

  constructor: function Client(config) {
    var ClientClass = this.loadClientClass(config || {});
    if (ClientClass) return new ClientClass(config);
    this.initialize(config);
  },

  initialize: function initialize(config) {
    this.config = new AWS.Config(AWS.config);
    if (config) this.config.update(config, true);
    this.setEndpoint(this.config.endpoint);
  },

  loadClientClass: function loadClientClass(clientConfig) {
    var config = clientConfig;
    if (!AWS.util.isEmpty(this.api)) {
      return;
    } else if (config.apiConfig) {
      return AWS.Client.defineClientApi(this.constructor, config.apiConfig);
    } else if (!this.constructor.clients) {
      return;
    } else {
      config = new AWS.Config(AWS.config);
      config.update(clientConfig, true);
      var version = config.apiVersions[this.constructor.serviceIdentifier];
      version = version || config.apiVersion;
      return this.getLatestClientClass(version);
    }
  },

  getLatestClientClass: function getLatestClientClass(version) {
    version = this.getLatestClientVersion(version);
    if (this.constructor.clients[version] === null) {
      AWS.Client.defineClientApi(this.constructor, version);
    }

    return this.constructor.clients[version];
  },

  getLatestClientVersion: function getLatestClientVersion(version) {
    /*jshint maxcomplexity:10*/
    if (!this.constructor.clients || this.constructor.clients.length === 0) {
      throw new Error('No clients defined on ' +
                      this.constructor.serviceIdentifier);
    }

    if (!version) {
      version = 'latest';
    } else if (AWS.util.isType(version, Date)) {
      version = AWS.util.date.iso8601(version).split('T')[0];
    }

    if (Object.hasOwnProperty(this.constructor.clients, version)) {
      return version;
    }

    var keys = Object.keys(this.constructor.clients).sort();
    for (var i = keys.length - 1; i >= 0; i--) {
      if (keys[i] <= version) return keys[i];
    }

    throw new Error('Could not find ' + this.constructor.serviceIdentifier +
                    ' API to satisfy version constraint `' + version + '\'');
  },

  api: {},

  defaultRetryCount: 3,

  makeRequest: function makeRequest(operation, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = {};
    }

    var request =  new AWS.Request(this, operation, params);
    this.addAllRequestListeners(request);

    if (callback) {
      request.on('complete', function (resp) {
        callback.call(resp, resp.error, resp.data);
      });
      request.send();
    }

    return request;
  },

  addAllRequestListeners: function addAllRequestListeners(request) {
    var list = [AWS.events, AWS.EventListeners.Core,
                this.serviceInterface()];
    for (var i = 0; i < list.length; i++) {
      if (list[i]) request.addListeners(list[i]);
    }

    // disable parameter validation
    if (!this.config.paramValidation) {
      request.removeListener('validate',
        AWS.EventListeners.Core.VALIDATE_PARAMETERS);
    }

    this.setupRequestListeners(request);
  },

  setupRequestListeners: function setupRequestListeners() {
  },

  serviceInterface: function serviceInterface() {
    /*jshint maxcomplexity:8*/
    switch (this.api.format) {
      case 'query': return AWS.EventListeners.Query;
      case 'json': return AWS.EventListeners.Json;
      case 'rest-json': return AWS.EventListeners.RestJson;
      case 'rest-xml': return AWS.EventListeners.RestXml;
    }
    if (this.api.format) {
      throw new Error('Invalid service `format\' ' +
        this.api.format + ' in API config');
    }
  },

  successfulResponse: function successfulResponse(resp) {
    return resp.httpResponse.statusCode < 300;
  },

  /**
   * How many times a failed request should be retried before giving up.
   * the defaultRetryCount can be overriden by client classes.
   */
  numRetries: function numRetries() {
    if (this.config.maxRetries !== undefined) {
      return this.config.maxRetries;
    } else {
      return this.defaultRetryCount;
    }
  },

  retryDelays: function retryDelays() {
    var retryCount = this.numRetries();
    var delays = [];
    for (var i = 0; i < retryCount; ++i) {
      delays[i] = Math.pow(2, i) * 30;
    }
    return delays;
  },

  retryableError: function retryableError(error) {
    if (this.networkingError(error)) return true;
    if (this.expiredCredentialsError(error)) return true;
    if (this.throttledError(error)) return true;
    if (error.statusCode >= 500) return true;
    return false;
  },

  networkingError: function networkingError(error) {
    return error.code == 'NetworkingError';
  },

  expiredCredentialsError: function expiredCredentialsError(error) {
    // TODO : this only handles *one* of the expired credential codes
    return (error.code === 'ExpiredTokenException');
  },

  throttledError: function throttledError(error) {
    // this logic varies between clients
    return (error.code == 'ProvisionedThroughputExceededException');
  },

  setEndpoint: function setEndpoint(endpoint) {
    if (endpoint) {
      this.endpoint = new AWS.Endpoint(endpoint, this.config);
    } else if (this.api.globalEndpoint) {
      this.endpoint = new AWS.Endpoint(this.api.globalEndpoint, this.config);
    } else {
      var host = this.api.endpointPrefix + '.' + this.config.region + '.amazonaws.com';
      this.endpoint = new AWS.Endpoint(host, this.config);
    }
  }

});

AWS.util.update(AWS.Client, {

  /**
   * Adds one method for each operation described in the api configuration
   */
  defineMethods: function defineMethods(client) {
    AWS.util.each(client.prototype.api.operations, function iterator(method) {
      if (client.prototype[method]) return;
      client.prototype[method] = function (params, callback) {
        return this.makeRequest(method, params, callback);
      };
    });
  },

  defineClient: function defineClient(serviceIdentifier, versions, features) {
    if (!AWS.util.isType(versions, Array)) {
      features = versions;
      versions = [];
    }

    var client = inherit(AWS.Client, features || {});

    if (typeof serviceIdentifier === 'string') {
      // create versions hash
      var clients = {};
      for (var i = 0; i < versions.length; i++) {
        clients[versions[i]] = null;
      }

      client.clients = client.clients || clients;
      client.serviceIdentifier = client.serviceIdentifier || serviceIdentifier;
    } else { // defineClient called with an API
      client.prototype.api = serviceIdentifier;
      AWS.Client.defineMethods(client);
    }

    return client;
  },

  defineClientApi: function defineClientApi(superclass, version) {
    var client = inherit(superclass, {
      serviceIdentifier: superclass.serviceIdentifier
    });

    if (typeof version === 'string') {
      var apiFile = superclass.serviceIdentifier + '-' + version;
      try {
        client.prototype.api = require('./services/api/' + apiFile);
      } catch (err) {
        throw AWS.util.error(err, {
          message: 'Could not find API configuration ' + apiFile
        });
      }
      superclass.clients[version] = client;
    } else {
      client.prototype.api = version;
    }

    AWS.Client.defineMethods(client);
    return client;
  }
});

module.exports = AWS.Client;
