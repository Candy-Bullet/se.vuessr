/**********************************************************
 * Copyright (c) SESHENGHUO.COM All rights reserved       *
 **********************************************************/

/**
 * AppServer实例
 * @charset utf-8
 * @author lijun
 * @git: https://github.com/zwlijun/se.vuessr
 * @date 2018.12
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
//---------- express middleware ----------
const express = require('express');
const bodyParser = require('body-parser');
const connectRID = require('connect-rid');
const cors = require('cors');
const csurf = require('csurf');
const ErrorHandler = require('errorhandler');
const favicon = require('serve-favicon');
const serveStatic = require('serve-static');
const compression = require('compression');
const morgan = require('morgan');
const multer  = require('multer');
const session = require('express-session');
const responseTime = require('response-time');
const cookieParser = require('cookie-parser');
const connectTimeout = require('connect-timeout');
const notifier = require('node-notifier');
const rfs = require('rotating-file-stream');
//-------------------------------------------
const LRUCache = require('lru-cache');
const VUEServerRender = require('vue-server-renderer');
const proxy = require('http-proxy-middleware');
const jsonMerger = require("json-merger");
//-------------------------------------------
const VUESSRContext = require("./conf/server/context.conf");
const ProxyServiceConf = require("./conf/server/proxy.conf");
const ErrorPageConf = require("./conf/server/errorpage.conf");
const HttpConf = require("./conf/server/http.conf");
//-------------------------------------------

const resolve = file => path.resolve(__dirname, file);

const debugMode = process.env.DEBUG === "true";

const DEFAULT_SECURE_PORT = 0;
const DEFAULT_HTTP_PORT = 0;
const securePort = process.env.SECURE || DEFAULT_SECURE_PORT;
const httpPort = process.env.PORT || DEFAULT_HTTP_PORT;

const isProd = process.env.NODE_ENV === 'production';
const serverInfo =
    `env/${process.env.NODE_ENV}; ` + 
    `express/${require('express/package.json').version}; ` +
    `vue/${require('vue/package.json').version}; ` +
    `vue-server-renderer/${require('vue-server-renderer/package.json').version}`;

console.log("DEBUG MODE: " + debugMode);
console.log("server: " + serverInfo);

const lurCacheOptions = new LRUCache({
    max: 1000,
    maxAge: 1000 * 60 * 15
});

if(debugMode){
    require('easy-monitor')(VUESSRContext.service);
}

const expressAppServer = express();

expressAppServer.disable("x-powered-by");
expressAppServer.enable("trust proxy");

// 记录错误
const logDirectory = path.join(__dirname, 'logs');
// ensure log directory exists
fs.existsSync(logDirectory) || fs.mkdirSync(logDirectory);
// create a rotating write stream
var accessLogStream = rfs('access.log', {
  interval: '1d', // rotate daily
  path: logDirectory
});
var errorLogStream = rfs('error.log', {
  interval: '1d', // rotate daily
  path: logDirectory
});

expressAppServer.use(ErrorHandler({
    "log": (err, str, req) => {
        let title = 'Error in ' + req.method + ' ' + req.url;

        if(!isProd){
            notifier.notify({
                title: title,
                message: str
            });
        }else{
            req.extitle = title;
            req.exmsg = str;

            morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" :extitle - :exmsg', {
                stream: errorLogStream
            });
        }
    }
}))

expressAppServer.use(morgan('combined', {
    stream: accessLogStream
}));
expressAppServer.use(morgan('combined', {
    skip: function (req, res) { 
        return res.statusCode < 400 ;
    },
    stream: errorLogStream
}));

// create application/json parser
const JSONBodyParser = bodyParser.json();
// create application/x-www-form-urlencoded parser
const URLEncodedBodyParser = bodyParser.urlencoded({ extended: false });

expressAppServer.use(connectTimeout("30s"));
expressAppServer.use(connectRID({
    "headerName": "X-Connect-RID"
}));
expressAppServer.use(cookieParser());
expressAppServer.use(responseTime());

let serverRenderer;
let serverRendererPromise;
const renderTemplatePath = resolve('./src/templates/index.render.html');

if (isProd) {
    // In production: create server renderer using template and built server bundle.
    // The server bundle is generated by vue-ssr-webpack-plugin.
    const template = fs.readFileSync(renderTemplatePath, 'utf-8');
    const bundle = require('./dist/vue-ssr-server-bundle.json');
    // The client manifests are optional, but it allows the renderer
    // to automatically infer preload/prefetch links and directly add <script>
    // tags for any async chunks used during render, avoiding waterfall requests.
    const clientManifest = require('./dist/vue-ssr-client-manifest.json');
    serverRenderer = createRenderer(bundle, {
        template,
        clientManifest
    });
} else {
    // In development: setup the dev server with watch and hot-reload,
    // and create a new renderer on bundle / index template update.
    serverRendererPromise = require('./build/setup-dev-server')(
        expressAppServer,
        renderTemplatePath,
        (bundle, options) => {
            serverRenderer = createRenderer(bundle, options);
        }
    );
}

function createRenderer (bundle, options) {
  // https://github.com/vuejs/vue/blob/dev/packages/vue-server-renderer/README.md#why-use-bundlerenderer
  return VUEServerRender.createBundleRenderer(bundle, Object.assign(options, {
    // for component caching
    cache: lurCacheOptions,
    // this is only needed when vue-server-renderer is npm-linked
    basedir: resolve('./dist'),
    // recommended for performance
    runInNewContext: false
  }));
}

const serve = (path, cache) => express.static(resolve(path), {
    "maxAge": cache && isProd ? "7d" : 0,
    "etag": true === cache,
    "index": false,
    "setHeaders": (res, path, stat) => {
        res.setHeader("X-Server-Info", serverInfo);
    }
});

expressAppServer.use(compression({ 
    threshold: 0,
    level: 9
}));

/**
 * proxy middleware options
 * 代理跨域配置
 */
let proxyService = null;
let proxyServiceSize = ProxyServiceConf.length;
for(let i = 0; i < proxyServiceSize; i++){
    proxyService = ProxyServiceConf[i];

    if(proxyService.turn !== "on"){
        continue;
    }

    expressAppServer.use(proxy(proxyService.uri, proxyService.options));
}

function doRender(req, res){
    const s = Date.now();

    res.setHeader("Content-Type", "text/html");
    res.setHeader("X-Server-Info", serverInfo);

    const useHTTPS = (securePort > 0 && true === HttpConf.forceSecure && "http" === req.protocol);

    const errorHandler = err => {
        if(debugMode){
            console.log("errorHandler => ", err);
        }

        ErrorPageConf.process(err, req, res);
    }

    console.log(req.url, req.get("Host"))
    
    const clientInfo = ((req) => {
        let host = req.get("Host");
        let originalUrl = req.originalUrl;
        let protocol = req.protocol;
        let absoluteURL = protocol + "://" + host + originalUrl;
        let relativeURL = req.url;

        if(useHTTPS){
            host = host.replace("" + httpPort, "" + securePort);
            protocol = "https";
            absoluteURL = protocol + "://" + host + originalUrl;
        }

        return {
            "absoluteURL": absoluteURL,
            "relativeURL": relativeURL,
            "host": host,
            "pathname": req.path,
            "cookies": req.cookies
        };
    })(req);

    if(useHTTPS){
        res.redirect(301, clientInfo.absoluteURL);
        return ;
    }

    //------------------------------------------------------------
    const hmac = crypto.createHmac("sha1", VUESSRContext.service);
    hmac.update(clientInfo.absoluteURL);
    const hex_hmac = hmac.digest("hex");
    //------------------------------------------------------------

    const context = jsonMerger.mergeObjects([VUESSRContext, {
        "nonce": hex_hmac,
        "client": clientInfo,
        "server": serverInfo,
        "ogp": {
            "og:url": (VUESSRContext["ogp"] || {})["og:url"] || clientInfo.absoluteURL
        }
    }]);

    // console.log(context)

    serverRenderer.renderToStream(context)
        .on('error', errorHandler)
        .on('end', () => {
            const timing = (Date.now() - s);
            console.log(`whole request: ${timing}ms`);
        }).pipe(res);
}
const __routerRender = isProd ? doRender : (req, res) => {
    serverRendererPromise.then(() => doRender(req, res));
};

// expressAppServer.use(favicon('./favicon.ico'));
expressAppServer.use('/', serve('./dist', true));
expressAppServer.use('/static', serve('./dist/static', true));
expressAppServer.use('/manifest.json', serve('./dist/vue-ssr-client-manifest.json', true));
expressAppServer.use('/service-worker.js', serve('./dist/service-worker.js', true));

expressAppServer.get('*', __routerRender);

HttpConf.listen(expressAppServer, httpPort, securePort);

