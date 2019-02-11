const fs = require('fs')
const path = require('path')
//---------- express middleware ----------
const express = require('express')
const bodyParser = require('body-parser')
const connectRID = require('connect-rid')
const cors = require('cors')
const csurf = require('csurf')
const errorhandler = require('errorhandler')
const favicon = require('serve-favicon')
const serveStatic = require('serve-static')
const compression = require('compression')
const morgan = require('morgan')
const multer  = require('multer')
const session = require('express-session')
const responseTime = require('response-time')
const cookieParser = require('cookie-parser')
const connectTimeout = require('connect-timeout')
const notifier = require('node-notifier')
const rfs = require('rotating-file-stream')
//-------------------------------------------
const LRUCache = require('lru-cache')
const VUEServerRender = require('vue-server-renderer')
const proxy = require('http-proxy-middleware')
//-------------------------------------------
const resolve = file => path.resolve(__dirname, file)

const isProd = process.env.NODE_ENV === 'production'
const serverInfo =
    `env/${process.env.NODE_ENV}; ` + 
    `express/${require('express/package.json').version}; ` +
    `vue/${require('vue/package.json').version}; ` +
    `vue-server-renderer/${require('vue-server-renderer/package.json').version}`

console.log("server: " + serverInfo)

const lurCacheOptions = new LRUCache({
    max: 1000,
    maxAge: 1000 * 60 * 15
})

const expressAppServer = express()

// create application/json parser
const JSONBodyParser = bodyParser.json()
// create application/x-www-form-urlencoded parser
const URLEncodedBodyParser = bodyParser.urlencoded({ extended: false })

expressAppServer.use(connectRID({
    "headerName": "X-Connect-RID"
}))
expressAppServer.use(cookieParser())
expressAppServer.use(responseTime())

// 记录错误
const logDirectory = path.join(__dirname, 'logs')
// ensure log directory exists
fs.existsSync(logDirectory) || fs.mkdirSync(logDirectory)
// create a rotating write stream
var accessLogStream = rfs('access.log', {
  interval: '1d', // rotate daily
  path: logDirectory
})
var errorLogStream = rfs('error.log', {
  interval: '1d', // rotate daily
  path: logDirectory
})

expressAppServer.use(errorhandler({
    "log": (err, str, req) => {
        let title = 'Error in ' + req.method + ' ' + req.url

        if(process.env.NODE_ENV !== 'production'){
            notifier.notify({
                title: title,
                message: str
            })
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
}))
expressAppServer.use(morgan('combined', {
    skip: function (req, res) { 
        return res.statusCode < 400 
    },
    stream: errorLogStream
}))

let serverRenderer
let serverRendererPromise
const renderTemplatePath = resolve('./src/templates/index.render.html')

if (isProd) {
    // In production: create server renderer using template and built server bundle.
    // The server bundle is generated by vue-ssr-webpack-plugin.
    const template = fs.readFileSync(renderTemplatePath, 'utf-8')
    const bundle = require('./dist/vue-ssr-server-bundle.json')
    // The client manifests are optional, but it allows the renderer
    // to automatically infer preload/prefetch links and directly add <script>
    // tags for any async chunks used during render, avoiding waterfall requests.
    const clientManifest = require('./dist/vue-ssr-client-manifest.json')
    serverRenderer = createRenderer(bundle, {
        template,
        clientManifest
    })
} else {
    // In development: setup the dev server with watch and hot-reload,
    // and create a new renderer on bundle / index template update.
    serverRendererPromise = require('./build/setup-dev-server')(
        expressAppServer,
        renderTemplatePath,
        (bundle, options) => {
            serverRenderer = createRenderer(bundle, options)
        }
    )
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
  }))
}

const serve = (path, cache) => express.static(resolve(path), {
    "maxAge": cache && isProd ? "7d" : 0,
    "etag": true === cache,
    "setHeaders": (res, path, stat) => {
        res.setHeader("X-Server-Info", serverInfo)
    }
})

expressAppServer.use(compression({ threshold: 0 }))
// expressAppServer.use(favicon('./favicon.ico'))
expressAppServer.use('/dist', serve('./dist', true))
expressAppServer.use('/static', serve('./dist/static', true))
expressAppServer.use('/manifest.json', serve('./dist/vue-ssr-client-manifest.json', true))
expressAppServer.use('/service-worker.js', serve('./dist/service-worker.js', true))

/**
 * proxy middleware options
 * 代理跨域配置
 * @type {{target: string, changeOrigin: boolean, pathRewrite: {^/api: string}}}
 */
var options = {
    target: 'http://api.domain.com', // target host
    changeOrigin: true // needed for virtual hosted sites
};

var exampleProxy = proxy(options);
expressAppServer.use('/api', exampleProxy);

function doRender(req, res){
    const s = Date.now()

    res.setHeader("Content-Type", "text/html")
    res.setHeader("X-Server-Info", serverInfo)

    const errorHandler = err => {
        if (err && err.code === 401) {
            return res.redirect('/login');
        } else if (err && err.code === 404) {
            // return res.redirect('/404');
            res.status(404).end('404 | Page Not Found')
        } else {
            // Render Error Page or Redirect
            // return res.redirect('/500');
            res.status(500).end('500 | Internal Server Error')
        }
    }
    
    const context = {
        "title"   : "VUE SSR Base",
        "url"     : req.url,
        "cookies" : req.cookies,
        "server"  : serverInfo
    }

    serverRenderer.renderToStream(context)
        .on('error', errorHandler)
        .on('end', () => {
            const timing = (Date.now() - s)
            console.log(`whole request: ${timing}ms`)
        }).pipe(res)
}

expressAppServer.get('*', isProd ? doRender : (req, res) => {
    serverRendererPromise.then(() => doRender(req, res))
})

const port = process.env.PORT || 8080
expressAppServer.listen(port, () => {
    console.log(`server started at localhost: ${port}`)
})