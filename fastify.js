'use strict'

const Avvio = require('avvio')
const http = require('http')
const querystring = require('querystring')
let lightMyRequest

const {
  kChildren,
  kBodyLimit,
  kRoutePrefix,
  kLogLevel,
  kLogSerializers,
  kHooks,
  kSchemas,
  kValidatorCompiler,
  kSerializerCompiler,
  kReplySerializerDefault,
  kContentTypeParser,
  kReply,
  kRequest,
  kFourOhFour,
  kState,
  kOptions,
  kPluginNameChain
} = require('./lib/symbols.js')

const { createServer } = require('./lib/server')
const Reply = require('./lib/reply')
const Request = require('./lib/request')
const supportedMethods = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT', 'OPTIONS']
const decorator = require('./lib/decorate')
const ContentTypeParser = require('./lib/contentTypeParser')
const { Hooks, buildHooks } = require('./lib/hooks')
const { Schemas, buildSchemas } = require('./lib/schemas')
const { createLogger } = require('./lib/logger')
const pluginUtils = require('./lib/pluginUtils')
const reqIdGenFactory = require('./lib/reqIdGenFactory')
const { buildRouting, validateBodyLimitOption } = require('./lib/route')
const build404 = require('./lib/fourOhFour')
const getSecuredInitialConfig = require('./lib/initialConfigValidation')
const { defaultInitOptions } = getSecuredInitialConfig
const {
  codes: {
    FST_ERR_BAD_URL,
    FST_ERR_MISSING_MIDDLEWARE
  }
} = require('./lib/errors')

function fastify (options) {
  // Options validations
  options = options || {}

  if (typeof options !== 'object') {
    throw new TypeError('Options must be an object')
  }

  if (options.querystringParser && typeof options.querystringParser !== 'function') {
    throw new Error(`querystringParser option should be a function, instead got '${typeof options.querystringParser}'`)
  }

  validateBodyLimitOption(options.bodyLimit)

  const requestIdHeader = options.requestIdHeader || defaultInitOptions.requestIdHeader
  const querystringParser = options.querystringParser || querystring.parse
  const genReqId = options.genReqId || reqIdGenFactory()
  const requestIdLogLabel = options.requestIdLogLabel || 'reqId'
  const bodyLimit = options.bodyLimit || defaultInitOptions.bodyLimit
  const disableRequestLogging = options.disableRequestLogging || false
  const ajvOptions = Object.assign({
    customOptions: {},
    plugins: []
  }, options.ajv)
  const frameworkErrors = options.frameworkErrors

  // Ajv options
  if (!ajvOptions.customOptions || Object.prototype.toString.call(ajvOptions.customOptions) !== '[object Object]') {
    throw new Error(`ajv.customOptions option should be an object, instead got '${typeof ajvOptions.customOptions}'`)
  }
  if (!ajvOptions.plugins || !Array.isArray(ajvOptions.plugins)) {
    throw new Error(`ajv.plugins option should be an array, instead got '${typeof ajvOptions.customOptions}'`)
  }
  ajvOptions.plugins = ajvOptions.plugins.map(plugin => {
    return Array.isArray(plugin) ? plugin : [plugin]
  })

  // Instance Fastify components
  const { logger, hasLogger } = createLogger(options)

  // Update the options with the fixed values
  options.connectionTimeout = options.connectionTimeout || defaultInitOptions.connectionTimeout
  options.keepAliveTimeout = options.keepAliveTimeout || defaultInitOptions.keepAliveTimeout
  options.logger = logger
  options.genReqId = genReqId
  options.requestIdHeader = requestIdHeader
  options.querystringParser = querystringParser
  options.requestIdLogLabel = requestIdLogLabel
  options.disableRequestLogging = disableRequestLogging
  options.ajv = ajvOptions

  const initialConfig = getSecuredInitialConfig(options)

  // Default router
  const router = buildRouting({
    config: {
      defaultRoute: defaultRoute,
      onBadUrl: onBadUrl,
      ignoreTrailingSlash: options.ignoreTrailingSlash || defaultInitOptions.ignoreTrailingSlash,
      maxParamLength: options.maxParamLength || defaultInitOptions.maxParamLength,
      caseSensitive: options.caseSensitive,
      versioning: options.versioning
    }
  })
  // 404 router, used for handling encapsulated 404 handlers
  const fourOhFour = build404(options)

  // HTTP server and its handler
  const httpHandler = router.routing

  // we need to set this before calling createServer
  options.http2SessionTimeout = initialConfig.http2SessionTimeout
  const { server, listen } = createServer(options, httpHandler)
  server.on('clientError', handleClientError)

  const setupResponseListeners = Reply.setupResponseListeners
  const schemas = new Schemas()

  // Public API
  const fastify = {
    // Fastify internals
    [kState]: {
      listening: false,
      closing: false,
      started: false
    },
    [kOptions]: options,
    [kChildren]: [],
    [kBodyLimit]: bodyLimit,
    [kRoutePrefix]: '',
    [kLogLevel]: '',
    [kLogSerializers]: null,
    [kHooks]: new Hooks(),
    [kSchemas]: schemas,
    [kValidatorCompiler]: null,
    [kSerializerCompiler]: null,
    [kReplySerializerDefault]: null,
    [kContentTypeParser]: new ContentTypeParser(
      bodyLimit,
      (options.onProtoPoisoning || defaultInitOptions.onProtoPoisoning),
      (options.onConstructorPoisoning || defaultInitOptions.onConstructorPoisoning)
    ),
    [kReply]: Reply.buildReply(Reply),
    [kRequest]: Request.buildRequest(Request),
    [kFourOhFour]: fourOhFour,
    [pluginUtils.registeredPlugins]: [],
    [kPluginNameChain]: [],
    // routes shorthand methods
    delete: function _delete (url, opts, handler) {
      return router.prepareRoute.call(this, 'DELETE', url, opts, handler)
    },
    get: function _get (url, opts, handler) {
      return router.prepareRoute.call(this, 'GET', url, opts, handler)
    },
    head: function _head (url, opts, handler) {
      return router.prepareRoute.call(this, 'HEAD', url, opts, handler)
    },
    patch: function _patch (url, opts, handler) {
      return router.prepareRoute.call(this, 'PATCH', url, opts, handler)
    },
    post: function _post (url, opts, handler) {
      return router.prepareRoute.call(this, 'POST', url, opts, handler)
    },
    put: function _put (url, opts, handler) {
      return router.prepareRoute.call(this, 'PUT', url, opts, handler)
    },
    options: function _options (url, opts, handler) {
      return router.prepareRoute.call(this, 'OPTIONS', url, opts, handler)
    },
    all: function _all (url, opts, handler) {
      return router.prepareRoute.call(this, supportedMethods, url, opts, handler)
    },
    // extended route
    route: function _route (opts) {
      // we need the fastify object that we are producing so we apply a lazy loading of the function,
      // otherwise we should bind it after the declaration
      return router.route.call(this, opts)
    },
    // expose logger instance
    log: logger,
    // hooks
    addHook: addHook,
    // schemas
    addSchema: addSchema,
    getSchema: schemas.getSchema.bind(schemas),
    getSchemas: schemas.getSchemas.bind(schemas),
    setValidatorCompiler: setValidatorCompiler,
    setSerializerCompiler: setSerializerCompiler,
    setReplySerializer: setReplySerializer,
    // custom parsers
    addContentTypeParser: ContentTypeParser.helpers.addContentTypeParser,
    hasContentTypeParser: ContentTypeParser.helpers.hasContentTypeParser,
    // Fastify architecture methods (initialized by Avvio)
    register: null,
    after: null,
    ready: null,
    onClose: null,
    close: null,
    // http server
    listen: listen,
    server: server,
    // extend fastify objects
    decorate: decorator.add,
    hasDecorator: decorator.exist,
    decorateReply: decorator.decorateReply,
    decorateRequest: decorator.decorateRequest,
    hasRequestDecorator: decorator.existRequest,
    hasReplyDecorator: decorator.existReply,
    // fake http injection
    inject: inject,
    // pretty print of the registered routes
    printRoutes: router.printRoutes,
    // custom error handling
    setNotFoundHandler: setNotFoundHandler,
    setErrorHandler: setErrorHandler,
    // Set fastify initial configuration options read-only object
    initialConfig
  }

  Object.defineProperties(fastify, {
    pluginName: {
      get () {
        if (this[kPluginNameChain].length > 1) {
          return this[kPluginNameChain].join(' -> ')
        }
        return this[kPluginNameChain][0]
      }
    }
  })

  Object.defineProperty(fastify, 'prefix', {
    get: function () { return this[kRoutePrefix] }
  })
  Object.defineProperty(fastify, 'validatorCompiler', {
    get: function () { return this[kValidatorCompiler] }
  })
  Object.defineProperty(fastify, 'serializerCompiler', {
    get: function () { return this[kSerializerCompiler] }
  })

  // We are adding `use` to the fastify prototype so the user
  // can still access it (and get the expected error), but `decorate`
  // will not detect it, and allow the user to override it.
  Object.setPrototypeOf(fastify, { use })

  // Install and configure Avvio
  // Avvio will update the following Fastify methods:
  // - register
  // - after
  // - ready
  // - onClose
  // - close
  const avvio = Avvio(fastify, {
    autostart: false,
    timeout: Number(options.pluginTimeout) || defaultInitOptions.pluginTimeout,
    expose: { use: 'register' }
  })
  // Override to allow the plugin incapsulation
  avvio.override = override
  avvio.on('start', () => (fastify[kState].started = true))
  // cache the closing value, since we are checking it in an hot path
  avvio.once('preReady', () => {
    fastify.onClose((instance, done) => {
      fastify[kState].closing = true
      router.closeRoutes()
      if (fastify[kState].listening) {
        // No new TCP connections are accepted
        instance.server.close(done)
      } else {
        done(null)
      }
    })
  })

  // Set the default 404 handler
  fastify.setNotFoundHandler()
  fourOhFour.arrange404(fastify)

  router.setup(options, {
    avvio,
    fourOhFour,
    logger,
    hasLogger,
    setupResponseListeners,
    throwIfAlreadyStarted
  })

  return fastify

  function throwIfAlreadyStarted (msg) {
    if (fastify[kState].started) throw new Error(msg)
  }

  // HTTP injection handling
  // If the server is not ready yet, this
  // utility will automatically force it.
  function inject (opts, cb) {
    // lightMyRequest is dynamically laoded as it seems very expensive
    // because of Ajv
    if (lightMyRequest === undefined) {
      lightMyRequest = require('light-my-request')
    }

    if (fastify[kState].started) {
      if (fastify[kState].closing) {
        // Force to return an error
        const error = new Error('Server is closed')
        if (cb) {
          cb(error)
          return
        } else {
          return Promise.reject(error)
        }
      }
      return lightMyRequest(httpHandler, opts, cb)
    }

    if (cb) {
      this.ready(err => {
        if (err) cb(err, null)
        else lightMyRequest(httpHandler, opts, cb)
      })
    } else {
      return this.ready()
        .then(() => lightMyRequest(httpHandler, opts))
    }
  }

  function use () {
    throw new FST_ERR_MISSING_MIDDLEWARE()
  }

  // wrapper that we expose to the user for hooks handling
  function addHook (name, fn) {
    throwIfAlreadyStarted('Cannot call "addHook" when fastify instance is already started!')

    if (name === 'onSend' || name === 'preSerialization' || name === 'onError') {
      if (fn.constructor.name === 'AsyncFunction' && fn.length === 4) {
        throw new Error('Async function has too many arguments. Async hooks should not use the \'done\' argument.')
      }
    } else {
      if (fn.constructor.name === 'AsyncFunction' && fn.length === 3) {
        throw new Error('Async function has too many arguments. Async hooks should not use the \'done\' argument.')
      }
    }

    if (name === 'onClose') {
      this[kHooks].validate(name, fn)
      this.onClose(fn)
    } else {
      this.after((err, done) => {
        _addHook.call(this, name, fn)
        done(err)
      })
    }
    return this

    function _addHook (name, fn) {
      this[kHooks].add(name, fn)
      this[kChildren].forEach(child => _addHook.call(child, name, fn))
    }
  }

  // wrapper that we expose to the user for schemas handling
  function addSchema (schema) {
    throwIfAlreadyStarted('Cannot call "addSchema" when fastify instance is already started!')
    this[kSchemas].add(schema)
    this[kChildren].forEach(child => child.addSchema(schema))
    return this
  }

  function handleClientError (err, socket) {
    const body = JSON.stringify({
      error: http.STATUS_CODES['400'],
      message: 'Client Error',
      statusCode: 400
    })

    // Most devs do not know what to do with this error.
    // In the vast majority of cases, it's a network error and/or some
    // config issue on the the load balancer side.
    logger.trace({ err }, 'client error')
    socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n${body}`)
  }

  // If the router does not match any route, every request will land here
  // req and res are Node.js core objects
  function defaultRoute (req, res) {
    if (req.headers['accept-version'] !== undefined) {
      req.headers['accept-version'] = undefined
    }
    fourOhFour.router.lookup(req, res)
  }

  function onBadUrl (path, req, res) {
    if (frameworkErrors) {
      var id = genReqId(req)
      var childLogger = logger.child({ reqId: id })

      childLogger.info({ req }, 'incoming request')

      const request = new Request(id, req, null, req.headers, childLogger)
      const reply = new Reply(res, { onSend: [], onError: [] }, request, childLogger)
      return frameworkErrors(new FST_ERR_BAD_URL(path), request, reply)
    }
    const body = `{"error":"Bad Request","message":"'${path}' is not a valid url component","statusCode":400}`
    res.writeHead(400, {
      'Content-Type': 'application/json',
      'Content-Length': body.length
    })
    res.end(body)
  }

  function setNotFoundHandler (opts, handler) {
    throwIfAlreadyStarted('Cannot call "setNotFoundHandler" when fastify instance is already started!')

    fourOhFour.setNotFoundHandler.call(this, opts, handler, avvio, router.routeHandler)
  }

  function setValidatorCompiler (validatorCompiler) {
    throwIfAlreadyStarted('Cannot call "setValidatorCompiler" when fastify instance is already started!')
    this[kValidatorCompiler] = validatorCompiler
    return this
  }

  function setSerializerCompiler (serializerCompiler) {
    throwIfAlreadyStarted('Cannot call "setSerializerCompiler" when fastify instance is already started!')
    this[kSerializerCompiler] = serializerCompiler
    return this
  }

  function setReplySerializer (replySerializer) {
    throwIfAlreadyStarted('Cannot call "setReplySerializer" when fastify instance is already started!')

    this[kReplySerializerDefault] = replySerializer
    return this
  }

  // wrapper that we expose to the user for configure the custom error handler
  function setErrorHandler (func) {
    throwIfAlreadyStarted('Cannot call "setErrorHandler" when fastify instance is already started!')

    this._errorHandler = func
    return this
  }
}

// Function that runs the encapsulation magic.
// Everything that need to be encapsulated must be handled in this function.
function override (old, fn, opts) {
  const shouldSkipOverride = pluginUtils.registerPlugin.call(old, fn)

  if (shouldSkipOverride) {
    // after every plugin registration we will enter a new name
    old[kPluginNameChain].push(pluginUtils.getDisplayName(fn))
    return old
  }

  const instance = Object.create(old)
  old[kChildren].push(instance)
  instance[kChildren] = []
  instance[kReply] = Reply.buildReply(instance[kReply])
  instance[kRequest] = Request.buildRequest(instance[kRequest])
  instance[kContentTypeParser] = ContentTypeParser.helpers.buildContentTypeParser(instance[kContentTypeParser])
  instance[kHooks] = buildHooks(instance[kHooks])
  instance[kRoutePrefix] = buildRoutePrefix(instance[kRoutePrefix], opts.prefix)
  instance[kLogLevel] = opts.logLevel || instance[kLogLevel]
  instance[kSchemas] = buildSchemas(old[kSchemas])
  instance.getSchemas = instance[kSchemas].getSchemas.bind(instance[kSchemas])
  instance[pluginUtils.registeredPlugins] = Object.create(instance[pluginUtils.registeredPlugins])
  instance[kPluginNameChain] = [pluginUtils.getPluginName(fn) || pluginUtils.getFuncPreview(fn)]

  if (instance[kLogSerializers] || opts.logSerializers) {
    instance[kLogSerializers] = Object.assign(Object.create(instance[kLogSerializers]), opts.logSerializers)
  }

  if (opts.prefix) {
    instance[kFourOhFour].arrange404(instance)
  }

  for (const hook of instance[kHooks].onRegister) hook.call(this, instance, opts)

  return instance
}

function buildRoutePrefix (instancePrefix, pluginPrefix) {
  if (!pluginPrefix) {
    return instancePrefix
  }

  // Ensure that there is a '/' between the prefixes
  if (instancePrefix.endsWith('/')) {
    if (pluginPrefix[0] === '/') {
      // Remove the extra '/' to avoid: '/first//second'
      pluginPrefix = pluginPrefix.slice(1)
    }
  } else if (pluginPrefix[0] !== '/') {
    pluginPrefix = '/' + pluginPrefix
  }

  return instancePrefix + pluginPrefix
}

/**
 * These export configurations enable JS and TS developers
 * to consumer fastify in whatever way best suits their needs.
 * Some examples of supported import syntax includes:
 * - `const fastify = require('fastify')`
 * - `const { fastify } = require('fastify')`
 * - `import * as Fastify from 'fastify'`
 * - `import { fastify, TSC_definition } from 'fastify'`
 * - `import fastify from 'fastify'`
 * - `import fastify, { TSC_definition } from 'fastify'`
 */
fastify.fastify = fastify
fastify.default = fastify
module.exports = fastify
