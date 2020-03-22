///////////////////////////////////////////////////////////////////////////
// canal.js
//
// CAN to VSCP conversion node
//
// This file is part of the VSCP (https://www.vscp.org)
//
// The MIT License (MIT)
//
// Copyright © 2020 Ake Hedman, Grodans Paradis AB
// <info@grodansparadis.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//

"use strict";
    
const CANAL = require('node-canal');
const can = new CANAL.CNodeCanal();

const vscp = require('node-vscp');

// Debug:
// https://nodejs.org/api/util.html
// export NODE_DEBUG=canal  for all debug events
const util = require('util');
const debuglog = util.debuglog('canal');

module.exports = function(RED) {

    function CanalNode(config) {

        RED.nodes.createNode(this,config);
        var node = this;

        var flowContext = this.context().flow;

        debuglog(config);
        this.name = config.name;
        this.bvscp = config.bvscp || false; // VSCP message/event translation
        
        debuglog("bvscp = "+this.bvscp);
        debuglog("node name = "+this.name);

        this.context = config.context;

        // Retrieve the config node
        this.canaldrv = RED.nodes.getNode(config.driver);
        debuglog("Name = "+this.canaldrv.name);
        debuglog("Path = "+this.canaldrv.path);
        debuglog("Config = "+this.canaldrv.config);
        debuglog("Flags = "+this.canaldrv.flags);

        //////////////////////////////////////////////////////////////
        //           Input from driver received here
        //////////////////////////////////////////////////////////////
        const callback = (canmsg) => { 

            debuglog("Receiving : ",new Date, canmsg);

            // If this is pre-1.0, 'send' will be undefined, 
            // so fallback to node.send
            this.send = this.send || function() {
                node.send.apply(node, arguments)
            }

            var msg = {};

            if ( this.bvscp ) {

                debuglog("VSCP");

                msg.canmsg = canmsg;
                msg.payload = vscp.convertCanMsgToEvent(canmsg);

                debuglog("msg.canmsg = ", msg.canmsg);
                debuglog("msg.payload = ", msg.payload);
            }
            else {
                
                debuglog("CAN");

                msg.payload = canmsg;

                // Add compatible fields so non VSCP users
                // can find this useful as well.
                // msg.payload.id = canmsg.id;
                // if ( 'undefined' === typeof msg.payload.flags ) {
                //     msg.payload.flags = 0;
                // }

                debuglog("msg.payload = ", msg.payload);
            }

            // Let the user enjoy it
            debuglog("Send");
            this.send(msg);
        };

        this.status({fill:"red",shape:"dot",text:"closed"});

        // Init. connection to driver
        // Debug: "/home/akhe/development/VSCP/vscpl1drv-socketcan/linux/vscpl1drv-socketcan.so.1.1.0"
        var rv = can.init(this.canaldrv.path,
                            this.canaldrv.config,
                            this.canaldrv.flags,
                            callback );

        debuglog("init rv = ", rv);                                

        if ( CANAL.CANAL_ERROR_SUCCESS != rv ) {
            this.status({fill:"red",shape:"dot",text:"Failed initialization"});
            this.error("Failed to init CANAL driver.");
            return;
        }     

        debuglog("Ready to open driver.");
        // Open the connection                
        rv = can.open();
        if ( CANAL.CANAL_ERROR_SUCCESS == rv ) {
            this.status({fill:"green",shape:"dot",text:"open"});
        }
        else {
            this.status({fill:"red",shape:"dot",text:"open failed"});
            this.error("Failed to open CANAL driver.");
            return;
        }

        node.on('input', function(msg, send, done) {

            var ev = null;
            debuglog(msg.payload);

            var frame = {};
            frame.rtr = false;
            frame.ext = false;
            frame.obid = 0;   
            frame.flags = 0;
            var hrTime = process.hrtime();
            frame.timestamp = (hrTime[0] * 1000000 +
                               hrTime[1] / 1000);

            // OK with string form
            if ( typeof msg.payload === 'string' ) {

                debuglog("Message format == string");

                if ( this.bvscp ) {
                    debuglog("String input: ", msg.payload);               
                    ev = new vscp.Event();
                    ev.setFromString(msg.payload);
                    debuglog("Event object: ", ev);
                    frame = vscp.convertEventToCanMsg(ev);
                    debuglog("msg.payload",frame);    
                }
                else {

                    // <can_id>#{R|data}
                    // for CAN 2.0 frames
                    // 
                    // <can_id>##<flags>{data}
                    // for CAN FD frames
                    if( msg.payload && 
                        (msg.payload.indexOf("##") != -1 ) ) {   // CAN FD frame
                        
                        debuglog("FD Frame");

                        frame.id  = parseInt(msg.payload.split("##")[0],16);
                        debuglog("frame.id " + frame.id);
                        let data     = msg.payload.split("##")[1];
                        debuglog("data " + data);
                        frame.data   = Buffer.from(data,"hex");
                        frame.dlc    = frame.data.length;
                        if ( frame.dlc > 64 ) {

                            if (done) {
                                // Node-RED 1.0 compatible
                                done("Invalid CAN FD frame length " + frame.dlc);
                            } else {
                                // Node-RED 0.x compatible
                                node.error("Invalid CAN FD frame length " + frame.dlc, msg);
                            }
                        
                        }		
                        
                        debuglog(frame);
                    }
                    else if( msg.payload && 
                        (msg.payload.indexOf("#") != -1 ) ) {

                        debuglog("CAN Frame");

                        let id = msg.payload.split("#")[0];
                        frame.id  = parseInt(id,16);
                        if ( id.length > 3 ) {
                            frame.ext = true;
                        }
    
                        let data  = msg.payload.split("#")[1];

                        debuglog("R check",typeof data,data.indexOf("R"));
                        
                        if ( -1 == data.indexOf("R") ) {
                            debuglog( "CAN: ",frame.id,data);                        
                            var buffer   = Buffer.from(data,"hex");
                            frame.data = buffer;
                            frame.sizeData    = frame.data.length;
                            debuglog(frame.data);
                            if ( frame.data.length > 8 ) {
                                if (done) {
                                    // Node-RED 1.0 compatible
                                    done("Invalid CAN frame length " + frame.data.length, msg.payload);
                                } else {
                                    // Node-RED 0.x compatible
                                    node.error("Invalid CAN frame length " + frame.data.length, msg.payload);
                                }	
                            }
                            
                            debuglog(frame);
                        }
                        else {
                            // Remote transmission request
                            debuglog("Remote transmission request");
                            frame.dlc  = 0;
                            frame.data = null;                        
                        }

                    }
                    else {

                        // This is a string format we don't recognize

                        if (done) {
                            // Node-RED 1.0 compatible
                            done("Invalid CAN frame (string)");
                        } else {
                            // Node-RED 0.x compatible
                            node.error("Invalid CAN frame (string)", msg);
                        }
                        
                    }

                }

            }
            else if ( typeof msg.payload === 'object' ) {

                debuglog("Message format == object");

                if ( this.bvscp ) {
                    debuglog("JSON object",msg.payload);
                    debuglog("Data (msg.payload)",msg.payload.vscpData, Array.isArray(msg.payload.vscpData));
                    ev = new vscp.Event(msg.payload);
                    debuglog(ev);
                    debuglog("Data (Event)",ev.vscpData);
                    frame = vscp.convertEventToCanMsg(ev);
                    debuglog(frame);
                }
                else { 
                    // A standard CAN object is different from
                    // a CANAL object so we ned to translate
                    frame = msg.payload;
                    if ( 'number' !== msg.payload.sizeData) {
                        frame.sizeData = frame.data.length;
                        frame.dlc = frame.data.length;
                    }
                    // Try to be forgiving to 'old people'
                    if ( 'number' === msg.payload.canid) {
                        frame.id = frame.canid;
                    }
                    if (frame.ext) {
                        frame.flags = CANAL.CANAL_IDFLAG_EXTENDED;
                    }
                    if (frame.rtr) {
                        frame.flags = CANAL.CANAL_IDFLAG_RTR;
                    }
                }
            }
            else if (msg.payload instanceof vscp.Event ) {
                debuglog("Event");
                frame = vscp.convertEventToCanMsg(msg.payload);
                debuglog("frame");
            }
            // Invalid format
            else {
                if (done) {
                    // Node-RED 1.0 compatible
                    done("Payload has invalid format (should be canmsg object or string)", msg);
                } else {
                    // Node-RED 0.x compatible
                    node.error("Payload has invalid format (should be canmsg object or string)", msg);
                }
            }

            debuglog("Sending :",frame);
            rv = can.send(frame);
            done();

        });

        this.on('close', function(removed, done) {

            if (removed) {
                // This node has been deleted
            } else {
                // This node is being restarted                
            }

            rv = can.close();
            this.status({fill:"red",shape:"dot",text:"node-red:common.status.closed"});

            done();
        });
    }
    RED.nodes.registerType("canal",CanalNode);
}

