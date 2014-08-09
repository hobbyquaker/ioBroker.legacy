var express =   require('express');
var bodyParser = require('body-parser');
var socketio =  require('socket.io');
var crypto =    require('crypto');

var states = {};
var objects = {};

var app;
var appSsl;
var server;
var serverSsl;
var io;
var ioSsl;
var webserverUp = false,
    authHash = "",
    restApiDelayed = {
        timer:        null,
        responseType: '',
        response:     null,
        waitId:       0
    };

var adapter = require(__dirname + '/../../lib/adapter.js')({

    name:           'legacy',

    install: function (callback) {
        if (typeof callback === 'function') callback();
    },

    objectChange: function (id, obj) {
        objects[id] = obj;


    },

    stateChange: function (id, state) {
        states[id] = state;
        var arr = [id, state.val, state.ts, state.ack, state.lc];
        if (io)     io.sockets.emit('event', id, arr);
        if (ioSsl)  ioSsl.sockets.emit('event', id, arr);
    },

    unload: function (callback) {
        try {
            if (server) {
                adapter.log.info("terminating http server");
                server.close();

            }
            if (serverSsl) {
                adapter.log.info("terminating https server");
                serverSsl.close();

            }
            callback();
        } catch (e) {
            callback();
        }
    },

    ready: function () {
        main();
    }

});



function main() {
    getData();
    adapter.subscribeForeignStates('*');
    adapter.subscribeForeignObjects('*');

    if (adapter.config.ioListenPort) {
        app =  express();

        if (adapter.config.authentication && adapter.config.authentication.enabled) {
            app.use(express.basicAuth(adapter.config.authentication.user, adapter.config.authentication.password));
        }

        server =    require('http').Server(app)
    }

// Create md5 hash of user and password
    if (adapter.config.authentication.user && adapter.config.authentication.password) {
        // We can add the client IP address, so the key will be different for every client, but the server should calculate hash on the fly
        authHash = crypto.createHash('md5').update(adapter.config.authentication.user+adapter.config.authentication.password).digest("hex");
    }

    if (adapter.config.ioListenPortSsl) {
        var options = null;

        // Zertifikate vorhanden?
        try {
            options = {
                key: fs.readFileSync(__dirname+'/ssl/privatekey.pem'),
                cert: fs.readFileSync(__dirname+'/ssl/certificate.pem')
            };
        } catch(err) {
            adapter.log.error(err.message);
        }
        if (options) {
            appSsl = express();
            if (adapter.config.authentication && adapter.config.authentication.enabledSsl) {
                appSsl.use(express.basicAuth(adapter.config.authentication.user, adapter.config.authentication.password));
            }
            serverSsl = require('https').createServer(options, appSsl);
        }
    }

    initWebserver();



}






function getData() {
    adapter.log.info('requesting all states');
    adapter.getForeignStates('*', function (err, res) {
        adapter.log.info('received all states');
        states = res;
    });
    adapter.log.info('requesting all objects');
    adapter.objects.getObjectList({include_docs: true}, function (err, res) {
        adapter.log.info('received all objects');
        res = res.rows;
        objects = {};
        for (var i = 0; i < res.length; i++) {
            objects[res[i].doc._id] = res[i].doc;
        }
    });
}

function uploadParser(req, res, next) {
    var urlParts = url.parse(req.url, true);
    var query = urlParts.query;

    //console.log(query);

    // get the temporary location of the file
    var tmpPath = req.files.file.path;

    adapter.log.info("webserver <-- file upload "+req.files.file.name+" ("+req.files.file.size+" bytes) to "+tmpPath);
    adapter.log.info("webserver <-- file upload query params "+JSON.stringify(query));

    var newName;
    if (query.id) {
        newName = query.id + "." + req.files.file.name.replace(/.*\./, "");
    } else {
        newName = req.files.file.name;
    }
    // set where the file should actually exists - in this case it is in the "images" directory
    var targetPath = __dirname + "/" + query.path + newName;
    adapter.log.info("webserver     move uploaded file "+tmpPath+" -> "+targetPath);


    // move the file from the temporary location to the intended location
    fs.rename(tmpPath, targetPath, function(err) {
        if (err) throw err;
        // delete the temporary file, so that the explicitly set temporary upload dir does not get filled with unwanted files
        fs.unlink(tmpPath, function() {
            if (err) throw err;
            res.send('File uploaded to: ' + targetPath + ' - ' + req.files.file.size + ' bytes');
        });
    });
}

function findDatapoint(needle, hssdp) {
    if (!datapoints[needle]) {
        if (regaIndex.Name[needle]) {
            // Get by Name
            needle = regaIndex.Name[needle][0];
            if (hssdp) {
                // Get by Name and Datapoint
                if (regaObjects[needle].DPs) {
                    return regaObjects[needle].DPs[hssdp];
                } else {
                    return false;
                }
            }
        } else if (regaIndex.Address[needle]) {
            needle = regaIndex.Address[needle][0];
            if (hssdp) {
                // Get by Channel-Address and Datapoint
                if (regaObjects[needle].DPs && regaObjects[needle].DPs[hssdp]) {
                    needle = regaObjects[needle].DPs[hssdp];
                }
            }
        } else if (needle.match(/[a-zA-Z-]+\.[0-9A-Za-z-]+:[0-9]+\.[A-Z_]+/)) {
            // Get by full BidCos-Address
            addrArr = needle.split(".");
            if (regaIndex.Address[addrArr[1]]) {
                needle = regaObjects[regaIndex.Address[addrArr[1]]].DPs[addArr[2]];
            }
        } else {
            return false;
        }
    }
    return needle;

}

function restApiPost(req, res) {
    var path = req.params[0];
    var tmpArr = path.split("/");
    var command = tmpArr[0];
    var response;

    var responseType = "json";
    var status = 500;

    res.set("Access-Control-Allow-Origin", "*");

    switch(command) {
        case "setBulk":
            response = [];
            status = 200;
            for (var item in req.body) {
                var parts = item.split("/");
                var dp = findDatapoint(parts[0], parts[1]);
                if (dp == false) {
                    sres = {error: "datapoint "+item+" not found"};
                } else if (req.body[item] === undefined) {
                    sres = {error: "no value given for "+item};
                } else {
                    sres = {id:dp,value:req.body[item]};
                    setState(dp,req.body[item]);
                }
                response.push(sres);
            }
            break;
        default:
            response = {error: "command "+command+" unknown"};
    }
    switch (responseType) {
        case "json":
            res.json(response);
            break;
        case "plain":
            res.set('Content-Type', 'text/plain');
            res.send(response);
            break;

    }
}

function restApiDelayedAnswer() {
    clearTimeout(restApiDelayed.timer);
    restApiDelayed.timer = null;
    restApiDelayed.id = 0;
    switch (restApiDelayed.responseType) {
        case "json":
            restApiDelayed.res.json(restApiDelayed.response);
            break;
        case "plain":
            restApiDelayed.res.set('Content-Type', 'text/plain');
            restApiDelayed.res.send(restApiDelayed.response);
            break;
    }
    restApiDelayed.res      = null;
    restApiDelayed.response = null;

}

function restApi(req, res) {

    var path = req.params[0];
    var tmpArr = path.split("/");
    var command = tmpArr[0];
    var response;
    var wait = 0;

    var responseType = "json";
    var status = 500;

    res.set("Access-Control-Allow-Origin", "*");

    switch(command) {
        case "getPlainValue":
            responseType = "plain";
            if (!tmpArr[1]) {
                response = "error: no datapoint given";
                break;
            }
            var dp = findDatapoint(tmpArr[1], tmpArr[2]);
            if (!dp || !datapoints[dp]) {
                response = "error: datapoint not found";
            } else {
                response = String(datapoints[dp][0]);
                status = 200;
            }
            break;
        case "get":

            if (!tmpArr[1]) {
                response = {error: "no object/datapoint given"};
                break;
            }
            var dp = findDatapoint(tmpArr[1], tmpArr[2]);
            if (!dp) {
                response = {error: "object/datapoint not found"};
            } else {
                status = 200;
                response = {id:dp};
                if (datapoints[dp]) {
                    response.value = datapoints[dp][0];
                    response.ack = datapoints[dp][2];
                    response.timestamp = datapoints[dp][1];
                    response.lastchange = datapoints[dp][3];
                }
                if (regaObjects[dp]) {
                    for (var attr in regaObjects[dp]) {
                        response[attr] = regaObjects[dp][attr];
                    }
                }
            }
            break;
        case "getBulk":
            if (!tmpArr[1]) {
                response = {error: "no datapoints given"};
                break;
            }
            status = 200;
            response = {};
            var dps = tmpArr[1].split(",");
            for (var i = 0; i < dps.length; i++) {
                var parts = dps[i].split(";");
                dp = findDatapoint(parts[0], parts[1]);
                if (dp) {
                    response[dps[i]] = {"val":datapoints[dp][0], "ts":datapoints[dp][3]};
                }
            }
            break;
        case "set":
            if (!tmpArr[1]) {
                response = {error: "object/datapoint not given"};
            }
            var dp = findDatapoint(tmpArr[1], tmpArr[2]);
            var value;
            if (req.query) {
                value = req.query.value;
                wait  = req.query.wait || 0;
            }
            if (!value) {
                response = {error: "no value given"};
                wait = 0;
            } else {
                if (value === "true") {
                    value = true;
                } else if (value === "false") {
                    value = false;
                } else if (!isNaN(value)) {
                    value = parseFloat(value);
                }
                setState(dp, value);
                status = 200;
                response = {id:dp,value:value};
            }
            break;
        case "toggle":
            if (!tmpArr[1]) {
                response = {error: "object/datapoint not given"};
            }
            var dp = findDatapoint(tmpArr[1], tmpArr[2]);
            var value = datapoints[dp][0];
            if (value === true) value = 1;
            if (value === false) value = 0;
            value = 1 - parseInt(value, 10);
            setState(dp, value);
            status = 200;
            response = {id:dp,value:value};
            break;
        case "setBulk":
            response = [];
            status = 200;
            for (var item in req.query) {
                var parts = item.split("/");
                var dp = findDatapoint(parts[0], parts[1]);
                if (dp == false) {
                    sres = {error: "datapoint "+item+" not found"};
                } else if (req.query[item] === undefined) {
                    sres = {error: "no value given for "+item};
                } else {
                    sres = {id:dp,value:req.query[item]};
                    setState(dp,req.query[item]);
                }
                response.push(sres);
            }
            break;
        case "programExecute":
            if (!tmpArr[1]) {
                response = {error: "no program given"};
            }
            var id;
            if (regaIndex.Program && regaIndex.PROGRAM.indexOf(tmpArr[1]) != -1) {
                id = tmpArr[1]
            } else if (regaIndex.Name && regaIndex.Name[tmpArr[1]]) {
                if (regaObjects[tmpArr[1]].TypeName == "PROGRAM") {
                    id = regaIndex.Name[tmpArr[1]][0];
                }
            }
            if (!id) {
                response = {error: "program not found"};
            } else {
                status = 200;
                programExecute(id);
                response = {id:id};
            }
            break;
        case "getIndex":
            response = regaIndex;
            status = 200;
            break;
        case "getObjects":
            response = regaObjects;
            status = 200;
            break;
        case "getDatapoints":
            response = datapoints;
            status = 200;
            break;
        default:
            response = {error: "command "+command+" unknown"};
    }

    if (wait && response && response.id) {
        restApiDelayed.responseType = responseType;
        restApiDelayed.response     = response;
        restApiDelayed.id           = response.id;
        restApiDelayed.res          = res;
        restApiDelayed.timer = setTimeout(restApiDelayedAnswer, wait);
    } else {
        switch (responseType) {
            case "json":
                res.json(response);
                break;
            case "plain":
                res.set('Content-Type', 'text/plain');
                res.send(response);
                break;
        }
    }
}

function initWebserver() {
    if (app) {
        if (adapter.config.useCache) {
            var oneYear = 30758400000;
            app.use('/', express.static(__dirname + '/www', { maxAge: oneYear }));
            //app.use('/log', express.static(__dirname + '/log', { maxAge: oneYear }));
        } else {
            app.use('/', express.static(__dirname + '/www'));
            //app.use('/log', express.static(__dirname + '/log'));
        }

        // File Uploads
        //app.use(bodyParser({uploadDir:__dirname+'/tmp'}));
        // app.post('/upload', uploadParser);

        app.get('/api/*', restApi);

        app.post('/api/*', restApiPost);
        app.get('/auth/*', function (req, res) {
            res.set('Content-Type', 'text/javascript');
            if (adapter.config.authentication.enabled) {
                res.send("var socketSession='"+ authHash+"';");
            } else {
                res.send("var socketSession='nokey';");
            }
        });
        app.get('/lang/*', function (req, res) {
            res.set('Content-Type', 'text/javascript');
            res.send("var ccuIoLang='"+ (adapter.config.language || 'en') +"';");
        });
    }

    if (appSsl) {
        if (adapter.config.useCache) {
            var oneYear = 30758400000;
            appSsl.use('/', express.static(__dirname + '/www', { maxAge: oneYear }));
            appSsl.use('/log', express.static(__dirname + '/log', { maxAge: oneYear }));
        }
        else {
            appSsl.use('/', express.static(__dirname + '/www'));
            appSsl.use('/log', express.static(__dirname + '/log'));
        }

        // File Uploads
        appSsl.use(express.bodyParser({uploadDir:__dirname+'/tmp'}));
        appSsl.post('/upload', uploadParser);

        appSsl.get('/api/*', restApi);
        appSsl.post('/api/*', restApiPost);
        appSsl.get('/auth/*', function (req, res) {
            res.set('Content-Type', 'text/javascript');
            if (adapter.config.authentication.enabledSsl) {
                res.send("var socketSession='"+ authHash+"';");
            } else {
                res.send("var socketSession='nokey';");
            }
        });
        appSsl.get('/lang/*', function (req, res) {
            res.set('Content-Type', 'text/javascript');
            res.send("var ccuIoLang='"+ (adapter.config.language || 'en') +"';");
        });
    }

    if (adapter.config.authentication && adapter.config.authentication.enabled) {
        adapter.log.info("webserver     basic auth enabled");
    }

    if (server) {
        server.listen(adapter.config.ioListenPort);
        adapter.log.info("webserver     listening on port "+adapter.config.ioListenPort);
        io = socketio(server);
       // io.set('logger', { debug: function(obj) {adapter.log.debug("socket.io: "+obj)}, info: function(obj) {adapter.log.debug("socket.io: "+obj)} , error: function(obj) {adapter.log.error("socket.io: "+obj)}, warn: function(obj) {adapter.log.warn("socket.io: "+obj)} });
        initSocketIO(io);
    }

    if (serverSsl){
        serverSsl.listen(adapter.config.ioListenPortSsl);
        adapter.log.info("webserver ssl listening on port "+adapter.config.ioListenPortSsl);
        ioSsl = socketio.listen(serverSsl);
     //   ioSsl.set('logger', { debug: function(obj) {adapter.log.debug("socket.io: "+obj)}, info: function(obj) {adapter.log.debug("socket.io: "+obj)} , error: function(obj) {adapter.log.error("socket.io: "+obj)}, warn: function(obj) {adapter.log.warn("socket.io: "+obj)} });
        initSocketIO(ioSsl);

    }
    webserverUp = true;



}

function initSocketIO(_io) {

    /*
    _io.configure(function () {

        this.set('heartbeat timeout', 25);
        this.set('heartbeat interval', 10);

        this.set('authorization', function (handshakeData, callback) {
            var isHttps = (serverSsl !== undefined && this.server == serverSsl);
            if ((!isHttps && adapter.config.authentication.enabled) || (isHttps && adapter.config.authentication.enabledSsl)) {
                // do not check if localhost
                if(handshakeData.address.address.toString() == "127.0.0.1") {
                    adapter.log.verbose("local authentication " + handshakeData.address.address);
                    callback(null, true);
                } else
                if (handshakeData.query["key"] === undefined || handshakeData.query["key"] != authHash) {
                    adapter.log.warn("authentication error on "+(isHttps ? "https from " : "http from ") + handshakeData.address.address);
                    callback ("Invalid session key", false);
                } else{
                    adapter.log.verbose("authentication successful on "+(isHttps ? "https from " : "http from ") + handshakeData.address.address);
                    callback(null, true);
                }
            } else {
                callback(null, true);
            }
        });
    });
    */

    _io.sockets.on('connection', function (socket) {
        socketlist.push(socket);
        var address = socket.handshake.address;
        adapter.log.verbose("socket.io <-- " + address.address + ":" + address.port + " " + socket.transport + " connected");

        socket.on('log', function (sev, msg) {
            switch (sev) {
                case "info":
                    adapter.log.info(msg);
                    break;
                case "warn":
                    adapter.log.warn(msg);
                    break;
                case "error":
                    adapter.log.error(msg);
            }
        });

        socket.on('logDp', function (id) {
            if (!datapoints[id]) {
                return;
            }
            var ts = Math.round((new Date()).getTime() / 1000);
            devLog(ts, id, datapoints[id][0]);
        });

        socket.on('execCmd', function (cmd, callback) {
            adapter.log.info("exec "+cmd);
            childProcess.exec(cmd, callback);
        });

        socket.on('execScript', function (script, arg, callback) {
            adapter.log.info("script "+script + "["+arg+"]");
            var scr_prc = childProcess.fork(__dirname + script, arg);
            var result = null;
            scr_prc.on('message', function(obj) {
                // Receive results from child process
                console.log ("Message: " + obj);
                adapter.log.debug("script result: " + obj);
                result = obj;
            });
            scr_prc.on ("exit", function (code, signal) {
                if (callback) {
                    adapter.log.debug("script end result: " + result);
                    callback(script, arg, result);
                }
            });
        });

        socket.on('restartAdapter', function (adapter) {
            return restartAdapter(adapter)
        });

        socket.on('updateAddon', function (url, name) {
            var path = __dirname + "/update-addon.js";
            adapter.log.info("starting "+path+" "+url+" "+name);
            var updateProcess = childProcess.fork(path, [url, name]);
            updateProcess.on("close", function (code) {
                if (code == 0) {
                    var msg = " done.";
                } else {
                    var msg = " failed.";
                }
                if (io) {
                    io.sockets.emit("ioMessage", "Update "+name+msg);
                }
                if (ioSsl) {
                    ioSsl.sockets.emit("ioMessage", "Update "+name+msg);
                }
            });
        });

        socket.on('updateSelf', function () {
            /*
            var path = __dirname + "/update-self.js";
            adapter.config.updateSelfRunning = true;
            adapter.log.info("starting "+path);
            var updateProcess = childProcess.fork(path);
            if (io) {
                io.sockets.emit("ioMessage", "Update started. Please be patient...");
            }
            if (ioSsl) {
                ioSsl.sockets.emit("ioMessage", "Update started. Please be patient...");
            }
            updateProcess.on("close", function (code) {
                adapter.config.updateSelfRunning = false;
                if (code == 0) {
                    adapter.log.info("update done. restarting...");
                    if (os.platform().match(/^win/) && fs.existsSync(__dirname + "/restart_ccu_io.bat")) {
                        if (io) {
                            io.sockets.emit("ioMessage", "CCU.IO runs as windows service. Use Restart in the Windows menu.");
                        }
                        if (ioSsl) {
                            ioSsl.sockets.emit("ioMessage", "CCU.IO runs as windows service. Use Restart in the Windows menu.");
                        }
                    } else {
                        if (io) {
                            io.sockets.emit("ioMessage", "Update done. Restarting...");
                        }
                        if (ioSsl) {
                            ioSsl.sockets.emit("ioMessage", "Update done. Restarting...");
                        }
                        childProcess.fork(__dirname + "/ccu.io-server.js", ["restart"]);
                    }
                } else {
                    adapter.log.error("update failed.");
                    if (io) {
                        io.sockets.emit("ioMessage", "Error: update failed.");
                    }
                    if (ioSsl) {
                        ioSsl.sockets.emit("ioMessage", "Error: update failed.");
                    }
                }

            });
            */
        });

        socket.on('createBackup', function () {
            /*var path = __dirname + "/backup.js";
            adapter.log.info("starting "+path);
            var backupProcess = childProcess.fork(path, ["create"]);
            var fileName = "";
            backupProcess.on("message", function (msg) {
                fileName = msg;
            });
            if (io) {
                io.sockets.emit("ioMessage", "Backup started. Please be patient...");
            }
            if (ioSsl) {
                ioSsl.sockets.emit("ioMessage", "Backup started. Please be patient...");
            }
            backupProcess.on("close", function (code) {
                if (code == 0) {
                    if (io) {
                        io.sockets.emit("readyBackup", fileName);
                    }
                    if (ioSsl) {
                        ioSsl.sockets.emit("readyBackup", fileName);
                    }
                } else {
                    adapter.log.error("Backup failed.");
                    if (io) {
                        io.sockets.emit("ioMessage", "Error: Backup failed.");
                    }
                    if (ioSsl) {
                        ioSsl.sockets.emit("ioMessage", "Error: Backup failed.");
                    }
                }
            });*/
        });

        socket.on('createSnapshot', function () {
            /*var path = __dirname + "/backup.js";
            adapter.log.info("starting "+path);
            var backupProcess = childProcess.fork(path, ["snapshot"]);
            var fileName = "";
            backupProcess.on("message", function (msg) {
                fileName = msg;
            });
            if (io) {
                io.sockets.emit("ioMessage", "Snapshot started. Please be patient...");
            }
            if (ioSsl) {
                ioSsl.sockets.emit("ioMessage", "Snapshot started. Please be patient...");
            }
            backupProcess.on("close", function (code) {
                if (code == 0) {
                    if (io) {
                        io.sockets.emit("readySnapshot", fileName);
                    }
                    if (ioSsl) {
                        ioSsl.sockets.emit("readySnapshot", fileName);
                    }
                } else {
                    adapter.log.error("Snapshot failed.");
                    if (io) {
                        io.sockets.emit("ioMessage", "Error: Snapshot failed.");
                    }
                    if (ioSsl) {
                        ioSsl.sockets.emit("ioMessage", "Error: Snapshot failed.");
                    }
                }
            });
            */
        });

        socket.on('applyBackup', function (fileName) {
            /*
            var path = __dirname + "/backup.js";
            adapter.log.info("starting "+path);
            var backupProcess = childProcess.fork(path, [fileName]);
            var fileName = "";

            if (io) {
                io.sockets.emit("ioMessage", "Apply backup started. Please be patient...");
            }
            if (ioSsl) {
                ioSsl.sockets.emit("ioMessage", "Apply backup started. Please be patient...");
            }
            backupProcess.on("close", function (code) {
                if (code == 0) {
                    if (io) {
                        io.sockets.emit("applyReady", "Apply backup done. Restart CCU.IO");
                    }
                    if (ioSsl) {
                        ioSsl.sockets.emit("applyReady", "Apply backup done. Restart CCU.IO");
                    }
                } else {
                    adapter.log.error("Apply backup failed.");
                    if (io) {
                        io.sockets.emit("applyError", "Error: Backup failed.");
                    }
                    if (ioSsl) {
                        ioSsl.sockets.emit("applyError", "Error: Backup failed.");
                    }
                }
            });*/
        });

        socket.on('refreshAddons', function () {
            if (io) {
                io.sockets.emit("refreshAddons");
            }
            if (ioSsl) {
                ioSsl.sockets.emit("refreshAddons");
            }
        });

        socket.on('reloadData', function () {
            regaReady = false;

            updateStatus();
            clearRegaData();
            loadRegaData(0, null, true);
        });

        // Get list of all IP address on device
        socket.on('getIpAddresses', function (callback) {
            var ifaces=os.networkInterfaces();
            var ipArr = [];
            for (var dev in ifaces) {
                var alias=0;
                ifaces[dev].forEach(function(details){
                    if (details.family=='IPv4') {
                        ipArr.push ({name: dev+(alias?':'+alias:''), address: details.address});
                        ++alias;
                    }
                });
            }
            if (callback) {
                callback (ipArr);
            }
        });

        // Get platform name, type and if as service under windows
        socket.on('getPlatform', function (callback) {
            var p = os.platform();
            if (callback) {
                var plat = p;
                if (p == 'linux') {
                    plat = 'linux';
                } else if (p.match(/^win/)) {
                    plat = 'windows';
                } else if (p == 'darwin') {
                    plat = 'osx';
                }
                callback (plat, p, fs.existsSync(__dirname + "/restart_ccu_io.bat"));
            }
        });

        socket.on('restart', function () {
            adapter.log.info("received restart command");
            if (os.platform().match(/^win/) && fs.existsSync(__dirname + "/restart_ccu_io.bat")) {
                // Try to start script, that restarts service
                childProcess.execFile(__dirname + "/restart_ccu_io.bat");

                // If after 3 seconds this process still alive, try to restart over ccu.io-server.js
                setTimeout(function () {
                    childProcess.fork(__dirname + "/ccu.io-server.js", ["restart"]);
                }, 3000);
            } else {
                childProcess.fork(__dirname + "/ccu.io-server.js", ["restart"]);
            }
        });

        socket.on('restartRPC', function () {
            initRpc();
        });

        socket.on('reloadScriptEngine', function (callback) {
            if (adapter.config.scriptEngineEnabled) {
                if (childScriptEngine) {
                    childScriptEngine.kill();
                    delete childScriptEngine;
                }
                setTimeout(function () {
                    startScriptEngine();
                    if (callback) {
                        callback();
                    }
                }, 1500);
            }
        });

        socket.on('readdir', function (path, callback) {
            path = __dirname+"/"+path;
            adapter.log.verbose("socket.io <-- readdir "+path);
            fs.readdir(path, function (err, data) {
                if (err) {
                    callback(undefined);
                } else {
                    callback(data);
                }
            });
        });

        socket.on('readdirStat', function(path, callback) {
            path = __dirname + "/" + path;
            adapter.log.verbose("socket.io <-- readdirStat " + path);

            fs.readdir(path, function(err, files) {
                var data = [];
                if (err) {
                    callback(undefined);
                }
                if (files.length == 0) {
                    callback(undefined);
                } else {
                    files.forEach(function(file) {
                        fs.stat(path + file, function(err, stats) {
                            data.push({
                                "file": file,
                                "stats": stats
                            });
                            if (data.length == files.length) {
                                callback(data);
                            }
                        });
                    });
                }
            });
        });

        socket.on('rename', function(path_old,path, callback) {
            var p_old = __dirname + "/" + path_old;
            var p = __dirname + "/" + path;
            adapter.log.verbose("socket.io <-- rename " + path);

            fs.rename(p_old, p, function(err) {
                if (err) {
                    adapter.log.error("socket.io <-- rename "+path);
                    callback(err)
                }else{
                    callback(true)
                }
            });
        });

        socket.on('mkDir', function(path, callback) {
            var p = __dirname + "/" + path;

            adapter.log.verbose("socket.io <-- mkDir " + path);

            fs.mkdir(p,"0777", function(err) {
                if (err) {
                    adapter.log.error("socket.io <-- mkDir "+path);
                    callback(err)
                }else{
                    callback(true)
                }
            });
        });

        socket.on('removeRecursive', function(path, callback) {
            var p = __dirname + "/" + path;

            adapter.log.verbose("socket.io <-- mkDir " + path);
            fs.removeRecursive(p,function(err,status){
                if (err) {
                    adapter.log.error("socket.io <-- mkDir "+path);
                    callback(err)
                }else{
                    callback(true)
                }
            });
        });

        socket.on('writeFile', function (name, obj, callback) {
            // Todo Fehler abfangen
            var content = JSON.stringify(obj);
            if (JSON.stringify(obj) != content) {
                adapter.log.warn("writeFile strange JSON mismatch "+name);
            }
            adapter.log.verbose("socket.io <-- writeFile "+name+" "+content);
            fs.exists(adapter.config.datastorePath+name, function (exists) {
                if (exists) {
                    fs.rename(adapter.config.datastorePath+name, adapter.config.datastorePath+name+".bak", function() {
                        adapter.log.verbose("socket.io <-- writeFile created "+adapter.config.datastorePath+name+".bak");
                        fs.writeFile(adapter.config.datastorePath+name, content);
                        if (callback) { callback(); }
                    });
                } else {
                    fs.writeFile(adapter.config.datastorePath+name, content);
                    if (callback) { callback(); }
                }
            });
        });

        socket.on('writeAdapterSettings', function (adapter, obj, callback) {
            var name = 'adapter-' + adapter + '.json';
            adapter.config.adapters[adapter] = obj;

            // Todo Fehler abfangen
            var content = JSON.stringify(obj);
            if (JSON.stringify(obj) != content) {
                adapter.log.warn("writeFile strange JSON mismatch "+name);
            }
            adapter.log.verbose("socket.io <-- writeFile "+name+" "+content);
            fs.exists(adapter.config.datastorePath+name, function (exists) {
                if (exists) {
                    fs.rename(adapter.config.datastorePath+name, adapter.config.datastorePath+name+".bak", function() {
                        adapter.log.verbose("socket.io <-- writeFile created "+adapter.config.datastorePath+name+".bak");
                        fs.writeFile(adapter.config.datastorePath+name, content);
                        if (callback) { callback(); }
                    });
                } else {
                    fs.writeFile(adapter.config.datastorePath+name, content);
                    if (callback) { callback(); }
                }
            });
        });

        socket.on('writeRawFile', function (path, content, callback) {
            // Todo Fehler abfangen

            adapter.log.verbose("socket.io <-- writeRawFile "+path);
            fs.exists(__dirname+"/"+path, function (exists) {
                if (exists) {
                    fs.rename(__dirname+"/"+path, __dirname+"/"+path+".bak", function() {
                        adapter.log.verbose("socket.io <-- writeRawFile created "+__dirname+"/"+path+".bak");
                        fs.writeFile(__dirname+"/"+path, content);
                        if (callback) { callback(); }
                    });
                } else {
                    fs.writeFile(__dirname+"/"+path, content);
                    if (callback) { callback(); }
                }
            });
        });

        socket.on('writeBase64', function (path, content, callback) {
            adapter.log.info("socket.io <-- writeBase64 "+path);

            fs.writeFile(__dirname+"/"+path, content, "base64", function(err){
                if (err) {
                    adapter.log.error("socket.io <-- writeBase64 "+path);
                    callback(err)
                }else{
                    callback(true)
                }
            });
        });

        socket.on('readFile', function (name, callback) {
            adapter.log.verbose("socket.io <-- readFile "+name);

            fs.readFile(adapter.config.datastorePath+name, function (err, data) {
                if (err) {
                    adapter.log.error("failed loading file "+adapter.config.datastorePath+name);
                    callback(undefined);
                } else {
                    try {
                        var obj = JSON.parse(data);
                        callback(obj);
                    } catch (e) {
                        adapter.log.warn("failed parsing JSON file "+adapter.config.datastorePath+name);
                        callback(null, e);
                    }

                }
            });
        });

        socket.on('readRawFile', function (name, callback) {
            adapter.log.verbose("socket.io <-- readFile "+name);

            fs.readFile(__dirname+"/"+name, function (err, data) {
                if (err) {
                    adapter.log.error("failed loading file "+__dirname+"/"+name);
                    callback(undefined);
                } else {
                    callback(data.toString());
                }
            });
        });

        socket.on('readBase64', function (name, callback) {
            adapter.log.verbose("socket.io <-- readFile "+name);

            fs.readFile(__dirname+"/"+name,"base64", function (err, data) {
                if (err) {
                    adapter.log.error("failed reading Base64 file "+__dirname+"/"+name);
                    callback(undefined);
                } else {
                    callback({
                        mime: mime.lookup(__dirname+"/"+name),
                        data:data
                    });
                }
            });
        });

        socket.on('touchFile', function (name, callback) {
            adapter.log.verbose("socket.io <-- touchFile "+name);
            if (!fs.existsSync(__dirname+"/"+name)) {
                adapter.log.info("creating empty file "+name);
                var stream = fs.createWriteStream(__dirname+"/"+name);
                stream.end();
            }
        });

        socket.on('delRawFile', function (name, callback) {
            adapter.log.info("socket.io <-- delRawFile "+name);

            fs.unlink(__dirname+"/"+name, function (err, data) {
                if (err) {
                    adapter.log.error("failed deleting file "+__dirname+"/"+name);
                    callback(false);
                } else {
                    callback(true);
                }
            });
        });

        socket.on('readJsonFile', function (name, callback) {
            adapter.log.verbose("socket.io <-- readFile "+name);

            fs.readFile(__dirname+"/"+name, function (err, data) {
                if (err) {
                    callback(undefined);
                    if (name.slice(-13) == 'io-addon.json') return;
                    adapter.log.error("failed loading file "+__dirname+"/"+name);
                } else {
                    callback(JSON.parse(data));
                }
            });
        });

        socket.on('getUrl', function (url, callback) {
            adapter.log.info("GET "+url);
            if (url.match(/^https/)) {
                https.get(url, function(res) {
                    var body = "";
                    res.on("data", function (data) {
                        body += data;
                    });
                    res.on("end", function () {
                        callback(body);
                    });

                }).on('error', function(e) {
                    adapter.log.error("GET "+url+" "+ e.message);
                });
            } else {
                http.get(url, function(res) {
                    var body = "";
                    res.on("data", function (data) {
                        body += data;
                    });
                    res.on("end", function () {
                        callback(body);
                    });
                }).on('error', function(e) {
                    adapter.log.error("GET "+url+" "+ e.message);
                });
            }
        });

        socket.on('getStatus', function (callback) {
            var status = {
                ccuReachable: ccuReachable,
                ccuRegaUp: ccuRegaUp,
                ccuRegaData: regaReady,
                initsDone: initsDone
            }
            callback(status);
        });

        socket.on('getNextId', function (start, callback) {
            callback(nextId(start));
        });

        socket.on('getSettings', function (callback) {
            callback(settings);
        });

        socket.on('getVersion', function(callback) {
            callback(adapter.config.version);
        });

        socket.on('getDatapoints', function(callback) {
            adapter.log.verbose("socket.io <-- getData");

            callback(datapoints);
        });

        socket.on('getDatapoint', function(id, callback) {
            adapter.log.verbose("socket.io <-- getDatapoint " + id);

            callback(id, datapoints[id]);
        });

        socket.on('getObjects', function(callback) {
            adapter.log.verbose("socket.io <-- getObjects");
            callback(regaObjects);
        });

        socket.on('getIndex', function(callback) {
            adapter.log.verbose("socket.io <-- getIndex");
            callback(regaIndex);
        });

        socket.on('getStringtable', function(callback) {
            adapter.log.verbose("socket.io <-- getStringtable");
            callback(stringtable);
        });

        socket.on('addStringVariable', function(name, desc, str, callback) {
            adapter.log.verbose("socket.io <-- addStringVariable");
            regahss.addStringVariable(name, desc, str, function (id) {
                if (id) {
                    var ts = formatTimestamp();
                    datapoints[id] = [str, ts, true];
                    regaObjects[id] = {Name:name, TypeName: "VARDP", DPInfo: "DESC", ValueType: 20, ValueSubType: 11};
                    regaIndex.VARDP.push(id);
                    regaIndex.Name[id] = [13305, "VARDP", null];
                    adapter.log.info("added string variable "+id+" "+name);
                }
                callback(id);
            });
        });

        function nextId(id) {
            var id = id || 100000;
            while (regaObjects[id]) {
                id += 1;
            }
            return id;
        }

        function delObject(id, isRecursion) {
            if (!id) return;

            adapter.log.info("deleting object id="+id);

            // find children
            for (var cid in regaObjects) {
                if (regaObjects[cid].Parent == id) {
                    // recursion
                    delObject(cid, true);
                }
            }

            var obj = regaObjects[id];
            if (obj) {
                if (regaIndex.Name[obj.Name] && regaIndex.Name[obj.Name][0] == id) {
                    delete regaIndex.Name[obj.Name];
                }
                if (regaIndex.Address[obj.Address] && regaIndex.Address[obj.Address][0] == id) {
                    delete regaIndex.Address[obj.Address];
                }
            }

            delete regaObjects[id];


            if (datapoints[id]) {
                delete datapoints[id];
            }

            if (!isRecursion) {
                saveDatapoints();
                savePersistentObjects();
            }
        }



        function setObject(id, obj, callback) {
            if (!obj) {
                return;
            }
            if (obj._findNextId) {
                delete obj._findNextId;
                while (regaObjects[id]) {
                    id += 1;
                }
            }
            if (obj.rooms) {
                for (var i = 0; i < obj.rooms.length; i++) {
                    if (obj.rooms[i] === "") {
                        continue;
                    }
                    var roomId;
                    if (regaIndex.ENUM_ROOMS.indexOf(obj.rooms[i]) != -1) {
                        roomId = obj.rooms[i];
                    } else if (regaIndex.Name[obj.rooms[i]] && regaIndex.Name[obj.rooms[i]][1] == "ENUM_ROOMS") {
                        roomId = regaIndex.Name[obj.rooms[i]][0];
                    } else {
                        roomId = nextId(66000);
                        regaIndex.ENUM_ROOMS.push(roomId);
                        if (!regaIndex.Name[obj.rooms[i]]) {
                            regaIndex.Name[obj.rooms[i]] = [
                                roomId, "ENUM_ROOMS", null
                            ];
                        }
                        regaObjects[roomId] = {
                            "Name": obj.rooms[i],
                            "TypeName": "ENUM_ROOMS",
                            "EnumInfo": "",
                            "Channels": []
                        };
                        adapter.log.info("setObject room "+obj.rooms[i]+" created");
                    }
                    if (roomId && regaObjects[roomId].Channels.indexOf(id) == -1) {
                        regaObjects[roomId].Channels.push(id);
                    }
                }
                delete obj.rooms
            }
            if (obj.funcs) {
                for (var i = 0; i < obj.funcs.length; i++) {
                    if (obj.funcs[i] === "") {
                        continue;
                    }
                    var funcId;
                    if (regaIndex.ENUM_FUNCTIONS.indexOf(obj.funcs[i]) != -1) {
                        funcId = obj.funcs[i];
                    } else if (regaIndex.Name[obj.funcs[i]] && regaIndex.Name[obj.funcs[i]][1] == "ENUM_FUNCTIONS") {
                        funcId = regaIndex.Name[obj.funcs[i]][0];
                    } else {
                        funcId = nextId(66000);
                        regaIndex.ENUM_FUNCTIONS.push(funcId);
                        if (!regaIndex.Name[obj.funcs[i]]) {
                            regaIndex.Name[obj.funcs[i]] = [
                                funcId, "ENUM_FUNCTIONS", null
                            ];
                        }
                        regaObjects[funcId] = {
                            "Name": obj.funcs[i],
                            "TypeName": "ENUM_FUNCTIONS",
                            "EnumInfo": "",
                            "Channels": []
                        };
                        adapter.log.info("setObject function "+obj.funcs[i]+" created");
                    }
                    if (funcId && regaObjects[funcId].Channels.indexOf(id) == -1) {
                        regaObjects[funcId].Channels.push(id);
                    }
                }
                delete obj.funcs;
            }
            if (obj.favs) {
                for (var i = 0; i < obj.favs.length; i++) {
                    if (obj.favs[i] === "") {
                        continue;
                    }
                    var favId;
                    if (regaIndex.FAVORITE.indexOf(obj.favs[i]) != -1) {
                        favId = obj.favs[i];
                    } else if (regaIndex.Name[obj.favs[i]] && regaIndex.Name[obj.favs[i]][1] == "FAVORITE") {
                        favId = regaIndex.Name[obj.favs[i]][0];
                    } else {
                        favId = nextId(66000);
                        regaIndex.FAVORITE.push(favId);
                        if (!regaIndex.Name[obj.favs[i]]) {
                            regaIndex.Name[obj.favs[i]] = [
                                favId, "ENUM_FUNCTIONS", null
                            ];
                        }
                        regaObjects[favId] = {
                            "Name": obj.favs[i],
                            "TypeName": "FAVORITE",
                            "EnumInfo": "",
                            "Channels": []
                        };
                        adapter.log.info("setObject favorite "+obj.favs[i]+" created");
                    }
                    if (favId && regaObjects[favId].Channels.indexOf(id) == -1) {
                        regaObjects[favId].Channels.push(id);
                    }
                }
                delete obj.favs;
            }

            if (obj.TypeName) {
                if (!regaIndex[obj.TypeName]) {
                    regaIndex[obj.TypeName] = [];
                }
                if (regaIndex[obj.TypeName].indexOf(id) == -1) {
                    regaIndex[obj.TypeName].push(id);
                }
            }

            if (obj.Name) {
                regaIndex.Name[obj.Name] = [id, obj.TypeName, obj.Parent];
            }

            if (obj.Address) {
                regaIndex.Address[obj.Address] = [id, obj.TypeName, obj.Parent];
            }
            if (obj.TypeName && obj.TypeName.match(/DP$/)) {
                if (!obj.ValueUnit) {
                    obj.ValueUnit = "";
                }
                if (!datapoints[id] || obj.Value) {
                    adapter.log.verbose("adding dp "+id);
                    datapoints[id] = [obj.Value, formatTimestamp()];
                }
            }

            regaObjects[id] = obj;

            if (callback) {
                callback(id);
            }
        }

        socket.on('setObject', setObject);

        socket.on('delObject', delObject);

        // Eine Homematic Servicemeldung bestätigen
        socket.on('alarmReceipt', function (id) {
            adapter.log.verbose("rega          alarmReceipt "+id+" "+regaObjects[id].Name);
            regahss.script("dom.GetObject("+id+").AlReceipt();");
        });

        socket.on('setState', function(arr, callback) {
            // Todo Delay!

            //adapter.log.info("setState"+JSON.stringify(arr));

            var id =    arr[0],
                val =   arr[1],
                ts =    arr[2],
                ack =   arr[3];

            if (typeof id == "string") {
                if (regaIndex.Name[id]) {
                    id = regaIndex.Name[id][0];
                } else if (regaIndex.Address[id]) {
                    id = regaIndex.Address[id][0];
                }
            }

            //adapter.log.info("setState"+JSON.stringify(arr));

            setState(id,val,ts,ack, callback);

        });

        socket.on('programExecute', programExecute);

        socket.on('runScript', function(script, callback) {
            adapter.log.verbose("socket.io <-- script");
            regahss.script(script, function (data) {
                if (callback) { callback(data); }
            });
        });

        socket.on('disconnect', function () {
            var address = socket.handshake.address;
            adapter.log.verbose("socket.io <-- " + address.address + ":" + address.port + " " + socket.transport + " disconnected");
            socketlist.splice(socketlist.indexOf(socket), 1);
        });

        socket.on('close', function () {
            var address = socket.handshake.address;
            adapter.log.verbose("socket.io <-- " + address.address + ":" + address.port + " " + socket.transport + " closed");
            socketlist.splice(socketlist.indexOf(socket), 1);
        });
    });

}


function stop() {
    try {
        if (io && io.server) {
            adapter.log.info("closing http server");
            io.server.close();
            delete io.server ;
        }
    } catch (e) {
        adapter.log.error("something went wrong while terminating webserver: "+e)
    }

    try {
        if (ioSsl && ioSsl.server) {
            adapter.log.info("closing https server");
            ioSsl.server.close();
            delete ioSsl.server;
        }
    } catch (e) {
        adapter.log.error("something went wrong while terminating ssl webserver: "+e)
    }
}