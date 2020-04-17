// TTN-sensor-map
// Written by Jan Jongboom and Johan Stokking
// See LICENSE for details

const express = require('express');
const app = express();
const server = require('http').Server(app);
const hbs = require('hbs');
const ttn = require('ttn');
const fs = require('fs');
const Path = require('path');
const io = require('socket.io')(server);

// improved database
const dbFile = Path.join(__dirname, 'db.json');

// Some options for express (node.js web app library)
hbs.registerPartials(__dirname + '/views/partials');
app.use(express.static(__dirname + '/public'));
app.set('view engine', 'html');
app.set('views', __dirname + '/views');
app.engine('html', hbs.__express);

// Store some state about all applications
let applications = {};

// Store some state about all devices
let devices = {};

// Note here what data you're interested in, and how it can be obtained from a payload message
const config = {
    // Replace this with your own key
    mapsApiKey: 'ADD_YOUR_KEY',

    title: 'Smart Cville AQ sensor network',
    dataMapping: {
        temperature: {
            graphTitle: 'Temperature',
            yAxisLabel: 'Temperature (°C)',
            minY: 0, // suggested numbers, if numbers out of this range are received the graph will adjust
            maxY: 50,
            numberOfEvents: 30, // no. of events we send to the client
            data: payload => payload.payload_fields.temp
        },
        co2 : {
            graphTitle: 'CO2',
            yAxisLabel: 'CO2 (ppm)',
            minY: 0, // suggested numbers, if numbers out of this range are received the graph will adjust
            maxY: 5000,
            numberOfEvents: 30, // no. of events we send to the client
            data: payload => payload.payload_fields.co2
        },
        pm25: {
            graphTitle: 'Particulate Matter (2.5)',
            yAxisLabel: 'PM (2.5)',
            minY: 0, // suggested numbers, if numbers out of this range are received the graph will adjust
            maxY: 100,
            numberOfEvents: 30, // no. of events we send to the client
            data: payload => payload.payload_fields.pm25
        },
        pm10: {
            graphTitle: 'Particulate Matter (10)',
            yAxisLabel: 'PM(10)',
            minY: 0, // suggested numbers, if numbers out of this range are received the graph will adjust
            maxY: 100,
            numberOfEvents: 30, // no. of events we send to the client
            data: payload => payload.payload_fields.pm10
        },
        humidity: {
            graphTitle: 'Humidity',
            yAxisLabel: 'Humidity (%)',
            minY: 0, // suggested numbers, if numbers out of this range are received the graph will adjust
            maxY: 100,
            numberOfEvents: 30, // no. of events we send to the client
            data: payload => payload.payload_fields.humidity
        },
        // want more properties? just add more objects here
    },
    mapCenter: {
        lat: 38.029341,
        lng: -78.476682
    }
};

const dataMapping = config.dataMapping;
const mapCenter = config.mapCenter;

if (fs.existsSync(dbFile)) {
    console.time('LoadingDB');
    let db = JSON.parse(fs.readFileSync(dbFile, 'utf-8'));
    devices = db.devices;
    for (appId in db.applications) {
        if (db.applications.hasOwnProperty(appId)) {
            connectApplication(appId, db.applications[appId]).catch(err => console.error(err));
        }
    }
    console.timeEnd('LoadingDB');
}

// And handle requests
app.get('/', function (req, res, next) {
    let d = Object.keys(devices).map(k => {

        let keys = k.split(/\:/g);
        let o = {
            appId: keys[0],
            devId: keys[1],
            eui: devices[k].eui,
            lat: devices[k].lat,
            lng: devices[k].lng,
        };

        for (let mapKey of Object.keys(dataMapping)) {
            devices[k][mapKey] = devices[k][mapKey] || [];

            // grab last X events from the device
            o[mapKey] = devices[k][mapKey].slice(Math.max(devices[k][mapKey].length - (dataMapping[mapKey].numberOfEvents || 30), 1));
        }

        return o;
    })
    // Render index view, with the devices based on mapToView function
    res.render('index', {
        devices: JSON.stringify(d),
        config: JSON.stringify(config),
        title: config.title,
        mapsApiKey: config.mapsApiKey
    });
});

io.on('connection', socket => {
    socket.on('connect-application', (appId, accessKey) => {
        console.log('Connecting to application', appId, accessKey);
        connectApplication(appId, accessKey)
            .then(() => socket.emit('connected', appId))
            .catch(err => socket.emit('connect-failed', JSON.stringify(err)));
    });

    socket.on('location-change', (appId, devId, lat, lng) => {
        let key = appId + ':' + devId;
        if (!devices[key]) {
            console.error('Device not found', appId, devId);
            return;
        }

        console.log('Location changed', appId, devId, lat, lng);

        let d = devices[key];
        d.lat = lat;
        d.lng = lng;

        io.emit('location-change', {
            appId: appId,
            devId: devId,
            eui: d.eui,
            lat: d.lat,
            lng: d.lng
        }, lat, lng);
    });
});

server.listen(process.env.PORT || 7270, process.env.HOST || 'data.unixjazz.org', function () {
  console.log('Web server listening on host %s!', process.env.PORT || 7270);
});

function connectApplication(appId, accessKey) {
    if (applications[appId]) {
        if (!applications[appId].client) {
            throw 'Already connecting to app ' + appId;
        }
        applications[appId].client.close();
        delete applications[appId];
    }

    applications[appId] = {
        accessKey: accessKey
    }

    console.log('[%s] Connecting to TTN', appId);
    return new Promise((resolve, reject) => {

        return ttn.data(appId, accessKey).then(client => {
            applications[appId].client = client;

            client.on('error', (err) => {
                if (err.message === 'Connection refused: Not authorized') {
                    console.error('[%s] Key is not correct', appId);
                    client.close();
                    delete applications[appId];
                }
                reject(err);
            });

            client.on('connect', () => {
                console.log('[%s] Connected over MQTT', appId);
                resolve();
            });

            client.on('uplink', (devId, payload) => {
                // on device side we did /100, so *100 here to normalize
                if (typeof payload.payload_fields.analog_in_1 !== 'undefined') {
                    payload.payload_fields.analog_in_1 *= 100;
                }

                console.log('[%s] Received uplink', appId, devId, payload.payload_fields);

                let key = appId + ':' + devId;
                let d = devices[key] = devices[key] || {};
                d.eui = devId;

                for (let mapKey of Object.keys(dataMapping)) {
                    d[mapKey] = d[mapKey] || [];
                }

		// FIXME: provide coordinates from the node src
		switch (devId) {
		    case "sbox2":
    		        d.lat = 38.026;
                        d.lng = -78.501;
			break;
		    case "sbox3":
    		        d.lat = 38.019;
                        d.lng = -78.473;
			break;
		    case "sbox4":
    		        d.lat = 38.047;
                        d.lng = -78.483;
			break;
		    case "sbox5":
    		        d.lat = 38.035;
                        d.lng = -78.491;
			break;
		    case "sbox6":
    		        d.lat = 38.027;
                        d.lng = -78.515;
			break;
		    case "sbox7":
    		        d.lat = 38.025;
                        d.lng = -78.516;
			break;
		    case "sbox8":
    		        d.lat = 38.029;
                        d.lng = -78.484;
			break;
		    case "sbox9":
    		        d.lat = 38.025;
                        d.lng = -78.469;
			break;
		    case "sbox10":
    		        d.lat = 38.031;
                        d.lng = -78.479;
			break;
		    case "sbox11":
    		        d.lat = 38.029;
                        d.lng = -78.484;
			break;
	        }	
		//if (!d.lat) {
                //    d.lat = mapCenter.lat + (Math.random() / 10 - 0.05);
                //}
                //if (!d.lng) {
                //    d.lng = mapCenter.lng + (Math.random() / 10 - 0.05);
                //}

                for (let mapKey of Object.keys(dataMapping)) {
                    let v;
                    try {
                        v = dataMapping[mapKey].data(payload);
                    }
                    catch (ex) {
                        console.error('dataMapping[' + mapKey + '].data() threw an error', ex);
                        throw ex;
                    }
			console.log(v, typeof v);

                    if (typeof v !== 'undefined') {
                        d[mapKey].push({
                            ts: new Date(payload.metadata.time),
                            value: v
                        });

                        io.emit('value-change', mapKey, {
                            appId: appId,
                            devId: devId,
                            eui: d.eui,
                            lat: d.lat,
                            lng: d.lng
                        }, payload.metadata.time, v);
                    }
                }
            });

            console.log('[%s] Acquired MQTT client, connecting...', appId);
        }).catch(err => {
            console.error('[%s] Could not connect to The Things Network', appId, err);
            delete applications[appId];
            reject(err);
        });
    });
}

function exitHandler(options, err) {
    if (err) {
        console.error('Application exiting...', err);
    }

    let db = {
        devices: devices,
        applications: {}
    }
    for (appId in applications) {
        if (applications.hasOwnProperty(appId)) {
            db.applications[appId] = applications[appId].accessKey;
        }
    }
    fs.writeFileSync(dbFile, JSON.stringify(db), 'utf-8');

    if (options.exit) {
        process.exit();
    }
}

process.on('exit', exitHandler.bind(null, { cleanup: true }));
process.on('SIGINT', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR1', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR2', exitHandler.bind(null, { exit: true }));
process.on('uncaughtException', exitHandler.bind(null, { exit: true }));
