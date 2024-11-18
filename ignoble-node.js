var noble = require('@abandonware/noble');
var async = require('async');

module.exports = function(RED) {
	function ScannerNode(config) {
		RED.nodes.createNode(this, config);
		var node = this;

		function scanStart() {
			node.status({ fill: "blue", shape: "ring", text: "scanning" });
		}

		function scanStop() {
			node.status({});
			node.send({ payload: 1 });
		}

		node.on('input', function(msg) {
			noble.once('scanStart', scanStart);
			noble.once('scanStop', scanStop);
			noble.startScanning([], false, function(error) {
				if (error) {
					node.error(error);
					node.status({ fill: "red", shape: "dot", text: error });
				}
			});

			setTimeout(function() {
				noble.stopScanning();
			}, config.timeout);
		});

		node.on('close', function(done) {
			noble.removeListener('scanStart', scanStart);
			noble.removeListener('scanStop', scanStop);
			noble.stopScanning();
			done();
		});
	}
	RED.nodes.registerType('scanner', ScannerNode);

	function PeripheralNode(config) {
		RED.nodes.createNode(this, config);
		var node = this;

		node.on('input', function(msg) {
			var peripheral;

			for (var p in noble._peripherals) {
				if (config.mac === noble._peripherals[p].address) {
					peripheral = noble._peripherals[p];
					break;
				}
			}

			if (!peripheral) {
				node.send([ null, msg ]);
				return;
			}

			if (config.name) {
				msg._name = config.name;
			}

			msg._peripheral = peripheral.id;

			if (peripheral.state == 'connected') {
				node.send([ msg, null ]);
				return;
			}

			peripheral.connect(function(error) {
				if (error) {
					node.log(error);
					node.status({ fill: "red", shape: "dot", text: "error connecting" });
					node.send([ null, msg ]);
					return;
				}

				node.on('close', function(done) {
					peripheral.disconnect();
					done();
				});

				peripheral.once('disconnect', function() {
					if (config.timeout == 0) {
						node.status({ fill: "red", shape: "dot", text: "disconnected" });
					}
					node.send([ null, msg ]);
				});

				node.status({ fill: "green", shape: "dot", text: "connected" });

				peripheral.discoverServices([], function(error, services) {
					if (error) {
						node.status({ fill: "red", shape: "dot", text: "error finding services" });
						node.send([ null, msg ]);
						return;
					}
					node.send([ msg, null ]);
				});

				if (config.timeout > 0) {
					setTimeout(function() {
						node.status({});
						peripheral.disconnect();
					}, config.timeout);
				}
			});
		});

		node.on('close', function(done) {
			done();
		});
	}
	RED.nodes.registerType('peripheral', PeripheralNode);

	function ServiceNode(config) {
		RED.nodes.createNode(this, config);
		var node = this;

		node.on('input', function(msg) {
			if (!msg._peripheral) {
				node.status({ fill: "red", shape: "dot", text: "expecting peripheral in payload" });
				return;
			}

			var peripheral = noble._peripherals[msg._peripheral];
			if (!peripheral) {
				node.status({ fill: "red", shape: "dot", text: "expecting peripheral in noble" });
				return;
			}

			peripheral.once('disconnect', function() {
				node.status({});
			});

			async.eachSeries(peripheral.services, function(service, done) {
				service.discoverCharacteristics([], function(error, characteristics) {
					if (error) {
						node.log(error);
					}
					var m = Object.assign({}, msg);
					m._service = service.uuid;
					node.send(m);
					setTimeout(done, 500);
				});
			});
		});
	}
	RED.nodes.registerType('service', ServiceNode);

	function CharacteristicNode(config) {
		RED.nodes.createNode(this, config);
		var node = this;

		node.on('input', function(msg) {
			if (!msg._peripheral) {
				node.status({ fill: "red", shape: "dot", text: "expecting peripheral in payload" });
				return;
			}

			var peripheral = noble._peripherals[msg._peripheral];
			if (!peripheral) {
				node.status({ fill: "red", shape: "dot", text: "expecting peripheral in noble" });
				return;
			}

			if (!msg._service) {
				node.status({ fill: "red", shape: "dot", text: "expecting service in payload" });
				return;
			}

			var service = noble._services[peripheral.id][msg._service];
			if (!service) {
				node.status({ fill: "red", shape: "dot", text: "expecting service in noble" });
				return;
			}

			var characteristic = noble._characteristics[peripheral.id][msg._service][config.uuid];
			if (!characteristic) {
				return;
			}

			peripheral.once('disconnect', function() {
				node.status({});
			});

			function sendPayload(data) {
				var payload = {};
				payload.data = data;
				if (data.length == 4) {
					payload.dataInt = data.readInt32LE();
					payload.dataFloat = data.readFloatLE();
				}
				msg._characteristic = characteristic.uuid;
				msg.payload = payload;
				node.send(msg);
			}

			function subscribe() {
				if (characteristic.properties.join('').indexOf('notify') < 0) {
					return;
				}

				node.status({ fill: "green", shape: "dot", text: "subscribing" });

				characteristic.subscribe(function(error) {
					if (error) {
						node.status({ fill: "red", shape: "dot", text: "error subscribing" });
						return;
					}
					characteristic.on('data', function(data, isNotification) {
						if (!isNotification) {
							node.status({});
							return;
						}

						node.status({ fill: "blue", shape: "dot", text: "subscribed" });
						sendPayload(data);
					});
				});
			}

			function read() {
				if (characteristic.properties.join('').indexOf('read') < 0) {
					return;
				}

				node.status({ fill: "green", shape: "dot", text: "reading" });

				characteristic.read(function(error, data) {
					if (error) {
						node.status({ fill: "red", shape: "dot", text: "error reading" });
						return;
					}

					sendPayload(data);
					node.status({});
				});
			}

			if (config.subscribe) {
				subscribe();
			}
			else {
				read();
			}
		});
	}
	RED.nodes.registerType('characteristic', CharacteristicNode);

	function WCharacteristicNode(config) {
		RED.nodes.createNode(this, config);
		var node = this;

		node.on('input', function(msg) {
			if (!msg._peripheral) {
				node.status({ fill: "red", shape: "dot", text: "expecting peripheral in payload" });
				return;
			}

			var peripheral = noble._peripherals[msg._peripheral];
			if (!peripheral) {
				node.status({ fill: "red", shape: "dot", text: "expecting peripheral in noble" });
				return;
			}

			if (!msg._service) {
				node.status({ fill: "red", shape: "dot", text: "expecting service in payload" });
				return;
			}

			var service = noble._services[peripheral.id][msg._service];
			if (!service) {
				node.status({ fill: "red", shape: "dot", text: "expecting service in noble" });
				return;
			}

			var characteristic = noble._characteristics[peripheral.id][msg._service][config.uuid];
			if (!characteristic) {
				return;
			}

			var p = characteristic.properties.join('');
			if (p.indexOf('write') < 0) {
				return;
			}

			var withoutResponse = p.indexOf('writeWithoutResponse') >= 0;
			node.status({ fill: "green", shape: "dot", text: "writing" });

			var data = Buffer.from(msg.payload);
			characteristic.write(data, withoutResponse, function(error) {
				if (error) {
					node.status({ fill: "red", shape: "dot", text: "error writing" });
					return;
				}
				node.status({});
			});
		});
	}
	RED.nodes.registerType('characteristic out', WCharacteristicNode);
}
