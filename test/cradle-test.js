var path = require('path'),
    sys = require('sys'),
    assert = require('assert'),
    events = require('events'),
    http = require('http'),
    fs = require('fs');

require.paths.unshift(path.join(__dirname, '..', 'lib'),
                      path.join(__dirname, 'vendor', 'vows', 'lib'));

var vows = require('vows'),
    cradle = require('cradle');

function status(code) {
    return function (res) {
        assert.ok(res);
        assert.equal(res._headers.status, code);
    };
}

function mixin(target) {
    var objs = Array.prototype.slice.call(arguments, 1);
    objs.forEach(function (o) {
        for (var attr in o) { target[attr] = o[attr] }
    });
    return target;
}

var client = http.createClient(5984, '127.0.0.1');

function r(method, url, doc) {
    var promise = new(events.EventEmitter);
    var request = client.request(method, url, {});

    if (doc) { request.write(JSON.stringify(doc)) }

    request.addListener('response', function (res) {
        var body = '';

        res.setBodyEncoding('utf8');
        res.addListener('data', function (chunk) {
            body += (chunk || '');
        }).addListener('end', function () {
            var obj, response;

            try { obj = JSON.parse(body) }
            catch (e) { return promise.emit('error', e) }

            promise.emit('success', obj);
        });
    });
    request.end();
    return promise;
}

vows.tell("Cradle", {
    setup: function () {
        ['rabbits', 'pigs','badgers'].forEach(function (db) {
            r('DELETE', '/' + db);
        });
        r('PUT', '/rabbits');
        r('PUT', '/pigs');
        r('PUT', '/pigs/_design/pigs', {
            _id: '_design/pigs', views: {
                all: { map: "function (doc) { if (doc.color) emit(doc._id, doc) }" }
            }
        });
        r('PUT', '/pigs/mike', {color: 'pink'});
        r('PUT', '/rabbits/alex', {color: 'blue'});
        r('PUT', '/pigs/bill', {color: 'blue'});
        process.loop();
    },
    "Default connection settings": {
        setup: function () {
            cradle.setup({
                host: "http://cloudhead.io",
                port: 4242,
                milk: 'white'
            });
            return new(cradle.Connection);
        },
        "should be carried on to new Connections": function (c) {
            assert.equal(c.host, "http://cloudhead.io");
            assert.equal(c.port, 4242);
            assert.equal(c.options.milk, 'white');
            assert.equal(c.options.cache, true);
        },
        "with just a {} passed to a new Connection object": {
            setup: function () { return new(cradle.Connection)({milk: 'green'}) },
            "should override the defaults": function (c) {
                assert.equal(c.options.milk, 'green');
                assert.equal(c.port, 4242);
            }
        },
        "with a host and port passed to Connection": {
            setup: function () { return new(cradle.Connection)("255.255.0.0", 9696) },
            "should override the defaults": function (c) {
                assert.equal(c.host, '255.255.0.0');
                assert.equal(c.port, 9696);
            }
        },
        "with a host and port passed as a string to Connection": {
            setup: function () { return new(cradle.Connection)("8.8.8.8:4141") },
            "should override the defaults": function (c) {
                assert.equal(c.host, '8.8.8.8');
                assert.equal(c.port, 4141);
            }
        },
        "with a host, port and options passed to Connection": {
            setup: function () { return new(cradle.Connection)("4.4.4.4", 911, {raw: true}) },
            "should override the defaults": function (c) {
                assert.equal(c.host, '4.4.4.4');
                assert.equal(c.port, 911);
                assert.equal(c.options.raw, true);
            }
        }
    },

    //
    // Cache
    //
    "A Cradle connection (cache)": {
        setup: function () {
            return new(cradle.Connection)('127.0.0.1', 5984, {cache: true}).database('pigs');
        },
        "insert()": {
            setup: function (db) {
                var promise = new(events.EventEmitter);
                db.insert('bob', {ears: true}, function (e, res) {
                    promise.emit("success", db);
                });
                return promise;
            },
            "should write through the cache": function (db) {
                assert.ok(db.cache.has('bob'));
                assert.ok(db.cache.get('bob')._rev);
            },
            "and": {
                setup: function (db) {
                    var promise = new(events.EventEmitter);
                    db.save('bob', {size: 12}, function (e, res) {
                        promise.emit('success', res, db.cache.get('bob'));
                    });
                    return promise;
                },
                "return a 201": status(201),
                "allow an overwrite": function (res) {
                   assert.match(res.rev, /^2/);
                },
                "caches the updated document": function (res, doc) {
                    assert.ok(doc);
                    assert.equal(doc.size, 12);
                    assert.equal(doc.ears, true);
                }
            }
        },
        "remove()": {
            setup: function (db) {
                var promise = new(events.EventEmitter);
                db.insert('bruno', {}, function (e, res) {
                    promise.emit("success", db);
                });
                return promise;
            },
            "shouldn't ask for a revision": {
                setup: function (db) {
                    var promise = new(events.EventEmitter);
                    db.remove('bruno', function () { promise.emit('success', db) });
                    return promise;
                },
                "and should purge the cache": function (db) {
                    assert.equal(db.cache.has('bruno'), false);
                },
                "and raise an exception if you use remove() without a rev": function (db) {
                    //assert.throws(db.remove('bruno'), Error);
                }
            }
        },
        "saveAttachment()": {
            "updates the cache": {
                setup: function (db) {
                    var promise = new(events.EventEmitter);
                    db.insert({_id:'attachment-cacher'}, function (e,res) {
                        db.saveAttachment({_id:res.id, _rev:res.rev}, 'foo.txt', 'text/plain', 'Foo!', function (attRes) {
                            var cached = mixin({}, db.cache.store[res.id]);
                            promise.emit('success', cached);
                        });
                    });
                    return promise;
                },
                "with the revision": function (cached, res) {
                    assert.match(cached._rev, /^2-/);
                },
                "with the _attachments": function (cached) {
                    assert.ok(cached._attachments);
                    assert.ok(cached._attachments['foo.txt']);
                    assert.equal(cached._attachments['foo.txt'].stub, true);
                    assert.equal(cached._attachments['foo.txt'].content_type, 'text/plain');
                    assert.equal(cached._attachments['foo.txt'].revpos, 2);
                },
                "and is valid enough to re-save": {
                    setup: function (cached, db) {
                        var promise = new(events.EventEmitter);
                        db.insert(mixin({foo:'bar'}, cached), function (e,res) {
                            db.cache.purge(cached._id);
                            db.get(cached._id, function (e, res) {
                                promise.emit('success', res);
                            });
                        });
                        return promise;
                    },
                    "has the attachment": function (res) {
                        var att = res._attachments['foo.txt'];
                        assert.equal(att.stub, true);
                        assert.equal(att.content_type, 'text/plain');
                        assert.equal(att.length, 4);
                        assert.equal(att.revpos, 2);
                    },
                    "and actually updated the rev": function (res) {
                        assert.match(res._rev, /^3-/);
                    }
                }
            },
            "pulls the revision from the cache if not given": {
                setup: function (db) {
                    var promise = new(events.EventEmitter);
                    db.insert({_id:'attachment-saving-pulls-rev-from-cache'}, function (e, res) {
                        db.saveAttachment(res.id, 'foo.txt', 'text/plain', 'Foo!', function (attRes) {
                            promise.emit('success', attRes);
                        });
                    });
                    return promise;
                },
                "and saves successfully": status(201)
            }
        }
    },
    "Connection": {
        setup: function () {
            return new(cradle.Connection)('127.0.0.1', 5984, {cache: false});
        },
        "getting server info": {
            setup: function (c) { return c.info() },

            "returns a 200": status(200),
            "returns the version number": function (info) {
                assert.ok(info);
                assert.match(info.version, /\d+\.\d+\.\d+/);
            }
        },
        "getting the list of databases": {
            setup: function (c) {
                return c.databases();
            },
            "should contain the 'rabbits' and 'pigs' databases": function (dbs) {
                assert.ok(dbs.indexOf('rabbits') >= 0);
                assert.ok(dbs.indexOf('pigs') >= 0);
                assert.ok(dbs instanceof Array);
            }
        },
        "create()": {
            setup: function (c) {
                return c.database('badgers').create();
            },
            "returns a 201": status(201),
            "creates a database": {
                setup: function (res, c) { return c.database('badgers').exists() },
                "it exists": function (res) { assert.ok(res) }
            }
        },
        "destroy()": {
            setup: function (c) {
                return c.database('rabbits').destroy();
            },
            "returns a 200": status(200),
            "destroys a database": {
                setup: function (res, c) {
                    return c.database('rabbits').exists();
                },
                "it doesn't exist anymore": function (res) { assert.ok(! res) }
            }
        },
        "database()": {
            setup: function (c) { return c.database('pigs') },

            "info()": {
                setup: function (db) {
                    return db.info();
                },
                "returns a 200": status(200),
                "returns database info": function (info) {
                    assert.equal(info['db_name'], 'pigs');
                }
            },
            "fetching a document by id (GET)": {
                setup: function (db) { return db.get('mike') },
                "returns a 200": status(200),
                "returns the document": function (res) {
                    assert.equal(res.id, 'mike');
                }
            },
            "insert()": {
                "with an id & doc": {
                    setup: function (db) {
                        return db.insert('joe', {gender: 'male'});
                    },
                    "creates a new document (201)": status(201),
                    "returns the revision": function (res) {
                        assert.ok(res.rev);
                    }
                },
                "with a '_design' id": {
                    setup: function (db) {
                        return db.insert('_design/horses', {
                            all: {
                                map: function (doc) {
                                    if (doc.speed == 72) emit(null, doc);
                                }
                            }
                        });
                    },
                    "creates a doc (201)": status(201),
                    "returns the revision": function (res) {
                        assert.ok(res.rev);
                    },
                    "creates a design doc": {
                        setup: function (res, db) {
                            return db.view('horses/all');
                        },
                        "which can be queried": status(200)
                    }
                },
                "without an id (POST)": {},
            },
            "calling insert() with an array": {
                setup: function (db) {
                    return db.insert([{_id: 'tom'}, {_id: 'flint'}]);
                },
                "returns an array of document ids and revs": function (res) {
                    assert.equal(res[0].id, 'tom');
                    assert.equal(res[1].id, 'flint');
                },
                "should bulk insert the documents": {
                    setup: function (res, db) {
                        var promise = new(events.EventEmitter);
                        db.get('tom', function (e, tom) {
                            db.get('flint', function (e, flint) {
                                promise.emit('success', tom, flint);
                            });
                        });
                        return promise;
                    },
                    "which can then be retrieved": function (tom, flint) {
                        assert.ok(tom._id);
                        assert.ok(flint._id);
                    }
                }
            },
            "calling insert() with multiple documents": {
                setup: function (db) {
                    return db.insert({_id: 'pop'}, {_id: 'cap'}, {_id: 'ee'});
                },
                "returns an array of document ids and revs": function (res) {
                    assert.equal(res[0].id, 'pop');
                    assert.equal(res[1].id, 'cap');
                    assert.equal(res[2].id, 'ee');
                }
            },
            "getting all documents": {
                setup: function (db) {
                    var promise = new(events.EventEmitter);
                    db.all(function (err, res) { promise.emit('success', res);});
                    return promise;
                },
                "returns a 200": status(200),
                "returns a list of all docs": function (res) {
                    assert.ok(res.rows);
                }
            },
            "updating a document (PUT)": {
                setup: function (db) {
                    var promise = new(events.EventEmitter);
                    db.get('mike', function (err, doc) {
                        db.save('mike', doc.rev,
                            {color: doc.color, age: 13}, function (err, res) {
                            if (! err) promise.emit('success', res, db);
                            else promise.emit('error', res);
                        });
                    });
                    return promise;
                },
                "returns a 201": status(201),
                "returns the revision": function (res) {
                    assert.ok(res.rev);
                    assert.match(res.rev, /^2/);
                },
            },
            "deleting a document (DELETE)": {
                setup: function (db) {
                    var promise = new(events.EventEmitter);
                    db.get('bill', function (e, res) {
                        db.remove('bill', res.rev, function (e, res) {
                            promise.emit('success', res);
                        });
                    });
                    return promise;
                },
                "returns a 200": status(200)
            },
            "querying a view": {
                setup: function (db) {
                    var promise = new(events.EventEmitter);
                    db.view('pigs/all', function (err, res) { promise.emit('success', res); });
                    return promise;
                },
                "returns a 200": status(200),
                "returns view results": function (res) {
                    assert.ok(res.rows);
                    assert.equal(res.rows.length, 2);
                    assert.equal(res.total_rows, 2);
                },
                "returns an iterable object": function (res) {
                    res.forEach(function (k, v) {
                        assert.ok(v);
                        assert.ok(k === 'mike' || k === 'bill');
                    });
                },
                "with options": {

                },
                "with a start & end key": {

                }
            },
            "putting an attachment": {
                "to an existing document": {
                    "with given data": {
                        setup: function (db) {
                            var promise = new(events.EventEmitter);
                            db.insert({_id: 'complete-attachment'}, function (e, res) {
                                db.saveAttachment({_id: res.id, _rev: res.rev}, 'foo.txt', 'text/plain', 'Foo!',
                                    function (res) { promise.emit('success', res) });
                            });
                            return promise;
                        },
                        "returns a 201": status(201),
                        "returns the revision": function (res) {
                            assert.ok(res.rev);
                            assert.match(res.rev, /^2/);
                        },
                    },
                    "with streaming data": {
                        setup: function (db) {
                            var promise = new(events.EventEmitter), filestream;
                            db.insert({'_id':'streaming-attachment'}, function (e, res) {
                                filestream = fs.createReadStream(__dirname + "/../README.md");
                                db.saveAttachment({_id: res.id, _rev: res.rev}, 'foo.txt', 'text/plain', filestream,
                                    function (res) { promise.emit('success', res) });
                            })
                            return promise;
                        },
                        "returns a 201": status(201),
                        "returns the revision": function (res) {
                            assert.ok(res.rev);
                            assert.match(res.rev, /^2/);
                        }
                    },
                    "with incorrect revision": {
                        setup: function (db) {
                            var promise = new(events.EventEmitter), oldRev;
                            db.insert({_id: 'attachment-incorrect-revision'}, function (e, res) {
                                oldRev = res.rev;
                                db.insert({_id: 'attachment-incorrect-revision', _rev:res.rev}, function (e, res) {
                                    db.saveAttachment({_id: res.id, _rev: oldRev}, 'foo.txt', 'text/plain', 'Foo!',
                                        function (res) { promise.emit('success', res); });
                                });
                            });
                            return promise;
                        },
                        "returns a 409": status(409)
                    }
                },
                "to a non-existing document": {
                    setup: function (db) {
                        return db.saveAttachment('standalone-attachment', 'foo.txt', 'text/plain', 'Foo!');
                    },
                    "returns a 201": status(201),
                    "returns the revision": function (res) {
                        assert.ok(res.rev);
                        assert.match(res.rev, /^1-/);
                    }
                }
            },
            "getting an attachment": {
                "when it exists": {
                    setup: function (db) {
                        var promise = new(events.EventEmitter), response = {};
                        doc = {_id:'attachment-getter', _attachments:{ "foo.txt":{content_type:"text/plain", data:"aGVsbG8gd29ybGQ="} }};
                        db.insert(doc, function (e, res) {
                            var streamer = db.getAttachment('attachment-getter','foo.txt');
                            streamer.addListener('response', function (res) {
                                response._headers = res.headers;
                                response._headers.status = res.statusCode;
                                response.body = "";
                            });
                            streamer.addListener('data', function (chunk) { response.body += chunk; });
                            streamer.addListener('end', function () { promise.emit('success', response); });
                        });
                        return promise;
                    },
                    "returns a 200": status(200),
                    "returns the right mime-type in the header": function (res) {
                        assert.equal(res._headers['content-type'], 'text/plain');
                    },
                    "returns the attachment in the body": function (res) {
                        assert.equal(res.body, "hello world");
                    }
                },
                "when not found": {
                    setup: function (db) {
                        var promise = new(events.EventEmitter), response = {};
                        db.insert({_id:'attachment-not-found'}, function (e, res) {
                            var streamer = db.getAttachment('attachment-not-found','foo.txt');
                            streamer.addListener('response', function (res) {
                                response._headers = res.headers;
                                response._headers.status = res.statusCode;
                                promise.emit('success', response);
                            });
                        });
                        return promise;
                    },
                    "returns a 404": status(404)
                }
            }
        }
    }
});
