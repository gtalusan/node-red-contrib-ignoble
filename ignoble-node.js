var noble = require('noble');
var async = require('async');

module.exports = function(RED) {
	function ScannerNode(config) {
		RED.nodes.createNode(this, config);
		var node = this;
		var context = node.context();

		function scanStart() {
			node.status({ fill: "blue", shape: "ring", text: "scanning" });
			context.set('results', []);
		}

		function discover(peripheral) {
			var results = context.get('results') || [];
			results.push(peripheral);
			context.set('results', results);
		}

		function scanStop() {
			noble.removeListener('discover', discover);
			node.status({});
			async.eachSeries(context.get('results'), function(peripheral, done) {
				node.send({ _peripheral: peripheral });
				done();
			}, null);
		}

		node.on('input', function(msg) {
			noble.once('scanStart', scanStart);
			noble.on('discover', discover);
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
			noble.removeListener('discover', discover);
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
			var peripheral = msg._peripheral;

			if (config.mac != peripheral.address) {
				return;
			}

			if (config.name) {
				msg._name = config.name;
			}

			peripheral.connect(function(error) {
				if (error) {
					node.status({ fill: "red", shape: "dot", text: "error connecting" });
					return;
				}

				node.status({ fill: "green", shape: "dot", text: "connected" });

				peripheral.discoverServices([], function(error, services) {
					if (error) {
						node.status({ fill: "red", shape: "dot", text: "error finding services" });
						return;
					}
					msg._services = services;
					node.send(msg);
				});

				if (config.timeout > 0) {
					setTimeout(function() {
						node.status({});
						peripheral.disconnect();
					}, config.timeout);
				}
				else {
					peripheral.once('disconnect', function() {
						node.status({ fill: "red", shape: "dot", text: "disconnected" });
					});
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
			var peripheral = msg._peripheral;
			if (!peripheral) {
				node.status({ fill: "red", shape: "dot", text: "expecting peripheral in payload" });
				return;
			}

			peripheral.once('disconnect', function() {
				node.status({});
			});

			async.eachSeries(msg._services, function(service, done) {
				service.discoverCharacteristics([], function(error, characteristics) {
					if (error) {
						node.log(error);
					}
					msg._service = service;
					msg._characteristics = characteristics;
					node.send(msg);
					setTimeout(done, 500);
				});
			});
		});
	}
	RED.nodes.registerType('service', ServiceNode);

	function CharacteristicNode(config) {
		RED.nodes.createNode(this, config);
		var node = this;
		var search = [];
		if (config.uuid && config.uuid != "") {
			search.push(config.uuid);
		}

		node.on('input', function(msg) {
			var peripheral = msg._peripheral;
			if (!peripheral) {
				node.status({ fill: "red", shape: "dot", text: "expecting peripheral in payload" });
				return;
			}

			var service = msg._service;
			if (!service) {
				node.status({ fill: "red", shape: "dot", text: "expecting service in payload" });
				return;
			}

			function sendPayload(data) {
				var payload = {};
				payload.data = data;
				if (data.length == 4) {
					payload.dataInt = data.readInt32LE();
					payload.dataFloat = data.readFloatLE();
				}
				msg.payload = payload;
				node.send(msg);
			}

			function subscribeCharacteristic(characteristic, done) {
				if (characteristic.properties.join('').indexOf('notify') < 0) {
					done();
					return;
				}

				node.status({ fill: "green", shape: "dot", text: "subscribing" });

				peripheral.once('disconnect', function() {
					node.status({});
				});

				characteristic.subscribe(function(error) {
					if (error) {
						node.status({ fill: "red", shape: "dot", text: "error subscribing" });
						done();
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
					done();
				});
			}

			function readCharacteristic(characteristic, done) {
				if (characteristic.properties.join('').indexOf('read') < 0) {
					done();
					return;
				}

				node.status({ fill: "green", shape: "dot", text: "reading" });

				characteristic.read(function(error, data) {
					if (error) {
						node.status({ fill: "red", shape: "dot", text: "error reading" });
						done();
						return;
					}

					sendPayload(data);
					setTimeout(done, 500);
				});
			}

			async.filter(msg._characteristics,
				function(characteristic, done) {
					done(null, !config.uuid || config.uuid && characteristic.uuid === config.uuid);
				},
				function(error, characteristics) {
					async.eachSeries(characteristics, config.subscribe? subscribeCharacteristic : readCharacteristic, function() {
						if (config.subscribe) {
							node.log("done subscribing to " + peripheral.address);
						}
						else {
							node.log("done reading from " + peripheral.address);
						}
						node.status({});
					});
				}
			);
		});
	}
	RED.nodes.registerType('characteristic', CharacteristicNode);
}
