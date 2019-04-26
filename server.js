const express = require('express')();
const serveStatic = require('serve-static')
const csv = require('csv-express');
const bodyParser = require('body-parser');
const http = require('http');
const next = require('next');
const sse = require('server-sent-events');
const ip = require('ip');
const YOLO = require('./server/processes/YOLO');
const Opendatacam = require('./server/Opendatacam');
const cloneDeep = require('lodash.clonedeep');
const getURLData = require('./server/utils/urlHelper').getURLData;
const DBManager = require('./server/db/DBManager')
const MjpegProxy = require('mjpeg-proxy').MjpegProxy;
const intercept = require("intercept-stdout");

const SIMULATION_MODE = process.env.NODE_ENV !== 'production'; // When not running on the Jetson
// const SIMULATION_MODE = true;

const port = parseInt(process.env.PORT, 10) || 8080
const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

// Init processes
YOLO.init(SIMULATION_MODE);

// Init connection to db
DBManager.init().then(
  () => {
    console.log('Success init db')
  },
  err => {
    console.error(err)
  }
)

// TODO Move the stdout code into it's own module
var videoResolution = null;

if(SIMULATION_MODE) {
  videoResolution = {
    w: 1280,
    h: 720
  }
  Opendatacam.setVideoResolution(videoResolution)
}

var stdoutBuffer = "";
var unhook_intercept = intercept(function(text) {
  var stdoutText = text.toString();
  // Hacky way to get the video resolution from YOLO
  // We parse the stdout looking for "Video stream: 640 x 480"
  // alternative would be to add this info to the JSON stream sent by YOLO, would need to send a PR to https://github.com/alexeyab/darknet
  if(stdoutText.indexOf('Video stream:') > -1) {
    var splitOnStream = stdoutText.toString().split("stream:")
    var ratio = splitOnStream[1].split("\n")[0];
    videoResolution = {
      w : parseInt(ratio.split("x")[0].trim()),
      h : parseInt(ratio.split("x")[1].trim())
    }
    Opendatacam.setVideoResolution(videoResolution);
  }
  stdoutBuffer += stdoutText;
  // Keep buffer maximum to 3000 characters
  if(stdoutBuffer.length > 3000) {
    stdoutBuffer = stdoutBuffer.substring(stdoutBuffer.length - 3000, stdoutBuffer.length);
  }
});

app.prepare()
.then(() => {
  // Start HTTP server
  const server = http.createServer(express);
  express.use(bodyParser.json());

  // TODO add compression: https://github.com/expressjs/compression
  
  // This render pages/index.js for a request to /
  express.get('/', (req, res) => {

    YOLO.start(); // Inside yolo process will check is started

    const urlData = getURLData(req);
    Opendatacam.listenToYOLO(urlData);

    // Hacky way to pass params to getInitialProps on SSR
    // Should hydrate differently
    let query = req.query;
    query.countingAreas = Opendatacam.getCountingAreas();

    return app.render(req, res, '/', query)
  })

  /**
   * @api {get} /webcam/stream Stream (MJPEG)
   * @apiName Stream
   * @apiGroup Webcam
   *
   * @apiDescription Limitation: Only available after YOLO has started
   * 
   * This endpoint streams the webcam as a MJPEG stream. (streams the sequence of JPEG frames over HTTP).
   * The TCP connection is not closed as long as the client wants to receive new frames and the server wants to provide new frames
   * Only support one client at a time, if another one connect, the first HTTP connection is closed
   * 
   * More on MJPEG over HTTP: https://en.wikipedia.org/wiki/Motion_JPEG#M-JPEG_over_HTTP 
   *
  */
  express.get('/webcam/stream', (req, res) => {
    const urlData = getURLData(req);
    // Proxy MJPEG stream from darknet to avoid freezing issues
    return new MjpegProxy(`http://${urlData.address}:8090`).proxyRequest(req, res);
  });

  /**
   * @api {get} /webcam/resolution Resolution
   * @apiName Resolution
   * @apiGroup Webcam
   *
   * @apiDescription Limitation: Only available after YOLO has started
   * 
   * @apiSuccessExample {json} Success Response:
   *     {
   *       "w": 1280,
   *       "h": 720
   *     }
  */
  express.get('/webcam/resolution',  (req, res) => {
    res.json(videoResolution);
  })

  /**
   * @api {get} /console Console
   * @apiName Console
   * @apiGroup Helper
   *
   * @apiDescription Send the last 3000 characters of the server **stoud**
   * 
   * @apiSuccessExample Response
   *    Ready on http://localhost:8080 > Ready on http://192.168.0.195:8080
  */
  express.get('/console',  (req, res) => {
    res.send(stdoutBuffer);
  })

  /**
   * @api {post} /counter/areas Register areas
   * @apiName Register areas
   * @apiGroup Counter
   *
   * @apiDescription Send counter areas definition to server
   * 
   * It will replace all current counter areas (doesn't update a specific one)
   * 
   * If you want to remove all counter areas, send an empty object
   * 
   * @apiParam {Object} point1 First point of the counter line definition
   * @apiParam {Object} point2 Second point of the counter line definition
   * @apiParam {Object} refResolution Resolution of client side canvas where the line is drawn
   * 
   * @apiParamExample {json} Request Example:
   *     {
            "countingAreas": {
              "5287124a-4598-44e7-abaf-394018a7278b": {
                "color": "yellow",
                "location": {
                  "point1": {
                    "x": 221,
                    "y": 588
                  },
                  "point2": {
                    "x": 673,
                    "y": 546
                  },
                  "refResolution": {
                    "w": 1280,
                    "h": 666
                  }
                },
                "name": "Counter line 1"
              }
            }
          }
  * @apiSuccessExample Success-Response:
  *   HTTP/1.1 200 OK
  */
  express.post('/counter/areas', (req, res) => {
    Opendatacam.registerCountingAreas(req.body.countingAreas)
    res.sendStatus(200)
  });

  // Maybe Remove the need for dependency with direct express implem: https://github.com/expressjs/compression#server-sent-events
  /**
   * @api {get} /tracker/sse Tracker data
   * @apiName Data
   * @apiGroup Tracker
   *
   * @apiDescription From the browser, you can open a SSE (Server side event) connection to get data from Opendatacan on each frame.
   * 
   * **How to open an SSE connexion**
   * 
   * ```let eventSource = new EventSource("/tracker/sse")```
   * 
   * **How to get data on each frame**
   * 
   * ```eventSource.onmessage = (msg) => { let message = JSON.parse(msg.data); }```
   * 
   * Then it works like websocket but only the server can push data.
   * 
   * *Limitation: Only support one client at a time, if another one connect, the first SSE connection is closed*
   * 
   * More doc on server side event, read [What are SSE : Server Side Events](https://medium.com/axiomzenteam/websockets-http-2-and-sse-5c24ae4d9d96)
   * 
   * @apiSuccessExample {json} Frame example (once parsed to JSON):
   *  {
        "trackerDataForLastFrame": {
          "frameIndex": 4646,
          "data": [
            {
              "id": 5,
              "x": 340,
              "y": 237,
              "w": 60,
              "h": 45,
              "bearing": 103,
              "name": "car",
              "countingDeltas": {
                "94afa4f8-1d24-4011-a481-ad3036e959b4": 349.8589833356673
              }
            },
            {
              "id": 6,
              "x": 449,
              "y": 306,
              "w": 95,
              "h": 72,
              "bearing": 219,
              "name": "car",
              "countingDeltas": {
                "94afa4f8-1d24-4011-a481-ad3036e959b4": 273.532278392382
              }
            }
          ]
        },
        "counterSummary": {
          "94afa4f8-1d24-4011-a481-ad3036e959b4": {
            "car": 43,
            "_total": 43
          }
        },
        "trackerSummary": {
          "totalItemsTracked": 222
        },
        "videoResolution": {
          "w": 1280,
          "h": 720
        },
        "appState": {
          "yoloStatus": {
            "isStarting": true,
            "isStarted": false
          },
          "isListeningToYOLO": true,
          "recordingStatus": {
            "isRecording": true,
            "currentFPS": 13,
            "recordingId": "5cc3400252340f451cd7397a",
            "dateStarted": "2019-04-26T17:29:38.190Z"
          }
        }
      }
   * 
  */
  express.get('/tracker/sse', sse, function(req, res) {
    Opendatacam.startStreamingData(res.sse);
  });


  /**
   * @api {get} /recording/start Start recording
   * @apiName Start
   * @apiGroup Recording
   *
   * @apiDescription Start recording (persisting tracker data and counting data to db) 
   * 
   * @apiSuccessExample Success-Response:
   *   HTTP/1.1 200 OK
  */
  express.get('/recording/start', (req, res) => {
    Opendatacam.startRecording();
    res.sendStatus(200)
  });

  /**
   * @api {get} /recording/stop Stop recording
   * @apiName Stop
   * @apiGroup Recording
   *
   * @apiDescription Stop recording
   * 
   * @apiSuccessExample Success-Response:
   *   HTTP/1.1 200 OK
  */
  express.get('/recording/stop', (req, res) => {
    Opendatacam.stopRecording();
    res.sendStatus(200)
  });

  
  /**
   * @api {get} /recordings List
   * @apiName List all recording
   * @apiGroup Recordings
   *
   * @apiDescription Get list of all recording (TODO implement pagination)
   * 
   * @apiSuccessExample {json} Success Response:
   *     [
          {
            "_id": "5cc3400252340f451cd7397a",
            "dateStart": "2019-04-26T17:29:38.190Z",
            "dateEnd": "2019-04-26T17:32:14.563Z",
            "areas": {
              "94afa4f8-1d24-4011-a481-ad3036e959b4": {
                "color": "yellow",
                "location": {
                  "point1": {
                    "x": 241,
                    "y": 549
                  },
                  "point2": {
                    "x": 820,
                    "y": 513
                  },
                  "refResolution": {
                    "w": 1280,
                    "h": 666
                  }
                },
                "name": "test",
                "computed": {
                  "a": 0.06721747654390149,
                  "b": -609.7129253605938,
                  "xBounds": {
                    "xMin": 241,
                    "xMax": 820
                  }
                }
              }
            },
            "counterSummary": {
              "94afa4f8-1d24-4011-a481-ad3036e959b4": {
                "car": 111,
                "_total": 111
              }
            },
            "trackerSummary": {
              "totalItemsTracked": 566
            }
          }
        ]
  */
  express.get('/recordings', (req, res) => {
    DBManager.getRecordings().then((recordings) => {
      res.json(recordings)
    });
  });

  /**
   * @api {get} /recording/:id/tracker Tracker data
   * @apiName Tracker data
   * @apiGroup Recording
   *
   * @apiDescription Get tracker data for a specific recording **(can be very large as it returns all the data for each frame)**
   * 
   * @apiParam {String} id Recording id (_id field of /recordings)
   * 
   * @apiSuccessExample {json} Success Response:
   *     [
   *      {
            "_id": "5cc3400252340f451cd7397c",
            "recordingId": "5cc3400252340f451cd7397a",
            "timestamp": "2019-04-26T17:29:38.301Z",
            "objects": [
              {
                "id": 5,
                "x": 351,
                "y": 244,
                "w": 68,
                "h": 51,
                "bearing": 350,
                "name": "car"
              },
              {
                "id": 6,
                "x": 450,
                "y": 292,
                "w": 78,
                "h": 67,
                "bearing": 28,
                "name": "car"
              }
            ]
          }
        ]
  */
  express.get('/recording/:id/tracker', (req, res) => {
    DBManager.getTrackerHistoryOfRecording(req.params.id).then((trackerData) => {
      res.json(trackerData);
      // res.setHeader('Content-disposition', 'attachment; filename= trackerData.json');
      // res.setHeader('Content-type', 'application/json');
      // res.write(JSON.stringify(trackerData), function (err) {
      //     res.end();
      // })
    });
  })

  /**
   * @api {get} /recording/:id/counter Counter data
   * @apiName Counter data
   * @apiGroup Recording
   *
   * @apiDescription Get counter data for a specific recording
   * 
   * @apiParam {String} id Recording id (_id field of /recordings)
   * 
   * @apiSuccessExample {json} Success Response:
   *     [
          {
            "_id": "5cc3400252340f451cd7397a",
            "dateStart": "2019-04-26T17:29:38.190Z",
            "dateEnd": "2019-04-26T17:32:14.563Z",
            "areas": {
              "94afa4f8-1d24-4011-a481-ad3036e959b4": {
                "color": "yellow",
                "location": {
                  "point1": {
                    "x": 241,
                    "y": 549
                  },
                  "point2": {
                    "x": 820,
                    "y": 513
                  },
                  "refResolution": {
                    "w": 1280,
                    "h": 666
                  }
                },
                "name": "test",
                "computed": {
                  "a": 0.06721747654390149,
                  "b": -609.7129253605938,
                  "xBounds": {
                    "xMin": 241,
                    "xMax": 820
                  }
                }
              }
            },
            "counterSummary": {
              "94afa4f8-1d24-4011-a481-ad3036e959b4": {
                "car": 111,
                "_total": 111
              }
            },
            "trackerSummary": {
              "totalItemsTracked": 566
            },
            "counterHistory": [
              [
                {
                  "timestamp": "2019-04-26T17:29:38.811Z",
                  "area": "94afa4f8-1d24-4011-a481-ad3036e959b4",
                  "name": "car",
                  "id": 1021
                }
              ],
              [
                {
                  "timestamp": "2019-04-26T17:29:40.338Z",
                  "area": "94afa4f8-1d24-4011-a481-ad3036e959b4",
                  "name": "car",
                  "id": 1030
                }
              ]
          }
        ]
  */
  express.get('/recording/:id/counter', (req, res) => {
    DBManager.getCounterHistoryOfRecording(req.params.id).then((counterData) => {
      res.json(counterData);
      // res.setHeader('Content-disposition', 'attachment; filename= trackerData.json');
      // res.setHeader('Content-type', 'application/json');
      // res.write(JSON.stringify(trackerData), function (err) {
      //     res.end();
      // })
    });
  })

  express.use("/api/doc", serveStatic('apidoc'))

  // Global next.js handler
  express.get('*', (req, res) => {
    return handle(req, res)
  })

  

  server.listen(port, (err) => {
    if (err) throw err
    if (port === 80) {
      console.log(`> Ready on http://localhost`)
      console.log(`> Ready on http://${ip.address()}`)
    } else {
      console.log(`> Ready on http://localhost:${port}`)
      console.log(`> Ready on http://${ip.address()}:${port}`)
    }
  })
})


// Clean up node.js process if opendatacam stops or crash

process.stdin.resume(); //so the program will not close instantly

function exitHandler(options, exitCode) {
  // if (options.cleanup) {
  Opendatacam.clean();
  // };
  if (exitCode || exitCode === 0) console.log(exitCode);
  if (options.exit) process.exit();
}

//do something when app is closing
process.on('exit', exitHandler.bind(null,{cleanup:true}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {exit:true}));

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null, {exit:true}));
process.on('SIGUSR2', exitHandler.bind(null, {exit:true}));

//catches uncaught exceptions
// process.on('uncaughtException', exitHandler.bind(null, {exit:true}));


process.on('uncaughtException', function (err) {
  // This should not happen
  console.log("Pheew ....! Something unexpected happened. This should be handled more gracefully. I am sorry. The culprit is: ", err);
});