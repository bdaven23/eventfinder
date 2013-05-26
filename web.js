var express = require('express');
var util    = require('util');
var https = require('https');
var Parse = require('parse').Parse;
var moment = require('moment');
var async = require('async');
var pg = require('pg'); //native libpq bindings = `var pg = require('pg').native`
var app = express.createServer();
Parse.initialize(process.env.parseAppId, process.env.parseJsKey);

var fetchListOfEventsEveryXHpurs = 6;
var numberOfEventsToRetrieve = 100;
var parallelAsyncHttpRequests = 5;
var maxEventsToUpdate = 5;
var updateEventEveryXHours = 6;
var eventLimitForFbQuery = 50;
var dateRangeToDisplay = "1 day";
var askParseANewTokenAfterXMinutes = 20;
var deleteEventsOlderThan = "24 hours";

app.configure(function () {
	app.use(express.bodyParser());
	app.use(express.cookieParser());
	app.set('title', 'Event Finder');
	app.use("/js", express.static(__dirname + '/js'));
	app.use("/css", express.static(__dirname + '/css'));
	app.set('views', __dirname + '/views');
	app.set('view engine', 'ejs');
});

var port = process.env.PORT || 5000;
    app.listen(port, function() {
    console.log("Listening on " + port);
});


app.get('/', function (req, res) {
	res.render('index.ejs', {
        layout:    false,
        req:       req,
        app:       app,
	});
});

function executeFbQuery(query, token, cb) {
	var options = {
		host: 'graph.facebook.com',
		port: 443,
		path: "/fql?q=" + escape(query) + "&access_token=" + escape(token),
		method: 'GET',
		agent: false
	};
	
    var req = https.request(options, function (result) {
        var data = [];
        result.on('data', function (d) {
	        data.push(d);
        });
        result.on('error', function (err) {
            console.log('Error: ' + err);
        });
        result.on('end', function() {
            var theData = JSON.parse(data.join(''));
            if(theData.error == undefined) {
                console.log('Data Retrieved');
                cb(theData);
	        } else {
	            console.log('FB query ended with error: '+theData);   
	        }
        });
    });
    req.end();
}

function getNumberOfElements(size) {
   return (size - 10) / 12;
}

function executeFbQuery_HeadOnly(query, token, cb) {
	var options = {
		host: 'graph.facebook.com',
		port: 443,
		path: "/fql?q=" + escape(query) + "&access_token=" + escape(token),
		method: 'GET',
		headers: {
		    'Accept-Encoding': 'identity',
		    'agent': false
		}
	};
    var myReq = https.request(options, function (response) {
        var header = response.headers;
        response.destroy();        
        var elements = getNumberOfElements(header['content-length']);
        console.log(elements);
        cb(elements);
    });
    myReq.end();
}

app.get('/login', function (req, res) {
    var uid = req.query["uid"];
    var accessToken = req.query["token"];
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end();
    console.log('Login from uid ' + uid);
    fetchUserInfo(uid).then(function(userInfo) {updateIfNeeded(userInfo, uid, accessToken);});
    doTheBigUpdate();
});

app.get('/updateParseDb', function (req, res) {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end();
    console.log('Updating Parse DB');
    retrieveEventsToDisplay(function(events) {
    
    });
});

function fetchUserInfo(uid) {
    var FacebookUser = Parse.Object.extend("FacebookUser");
	var query = new Parse.Query(FacebookUser);
	query.equalTo("uid", uid);
	return query.first();
}

function updateIfNeeded(user, uid, accessToken) {
	var beforeThisItsTooOld = moment().subtract('hours', fetchListOfEventsEveryXHpurs);
	var userInfo = user;
	if(userInfo == undefined) {
		var FacebookUser = Parse.Object.extend("FacebookUser");
		userInfo = new FacebookUser();
		userInfo.set("uid", uid);
	}
	var last_update = userInfo.get("last_update");
	if((last_update == undefined) || (last_update < beforeThisItsTooOld)) {
		console.log('Updating user ' + uid);
		doAnUpdate(accessToken);
		userInfo.set("last_update", new Date());
	} else {
	    console.log('No need to update events from uid ' + uid);
	}
    userInfo.set("token", accessToken);
	userInfo.save();
}

function doAnUpdate(token) {
	var query = "SELECT eid, start_time FROM event WHERE privacy='OPEN' AND venue.id <> '' AND start_time > now() AND eid IN (SELECT eid FROM event_member WHERE start_time > now() AND (uid IN(SELECT uid2 FROM friend WHERE uid1=me()) OR uid=me())ORDER BY start_time ASC LIMIT "+ eventLimitForFbQuery +") ORDER BY start_time ASC";
	return executeFbQuery(query, token, function(results) {return insertEvents(results);});
}

function insertEvents(input) {
    return insertIntoDb("INSERT INTO events(eid, start_date) values($1, $2);", input.data);
}

function insertIntoDb(querySql, data) {
    pg.connect(process.env.DATABASE_URL, function(error, client, done) {
        if(error) {
            return;
        }
        var length = data.length;
        for (var i = 0; i < length; i++) {
            var query = client.query(querySql, [data[i].eid, data[i].start_time]);
            query.on('error', function(error) {
                if(error.code == 23505) { //if it's already present
                    error = 'Already present';
                }
                done();
                console.log(error);   
            });
            query.on('end', function(result) {
                done();
            });
        }
    });
}

function updateIntoDb(querySql, data) {
    pg.connect(process.env.DATABASE_URL, function(error, client, done) {
        if(error) {
            console.log(error);
            return;
        }
        var query = client.query(querySql, data);
        query.on('error', function(error) {  
            done();    
            console.log(error);
        });
        query.on('end', function(result) {
            done();
            console.log('Saved');
        });
    });
}

app.get('/retrieve', function (req, res) {
    console.log('Retrieve');
    var bottomRightLat = req.query["bottomRightLat"];
    var bottomRightLon = req.query["bottomRightLon"];
    var topLeftLat = req.query["topLeftLat"];
    var topLeftLon = req.query["topLeftLon"];
    retrieveEventsInBox({'latitude':bottomRightLat, 'longitude':bottomRightLon} , {'latitude':topLeftLat,'longitude':topLeftLon}, function(rows) {
        res.writeHead(200, {'Content-Type': 'text/json'});
        res.end(JSON.stringify(rows));
    });
});

/*
function retrieveNearbyEvents(lat, lon, cb) {
    var limit = 100;
    var query = "";
    query += "SELECT name, start_date AS start_time, attending_total AS people, location, latitude, longitude, eid ";
    query += "FROM events WHERE";
    query += " start_date >= 'today' AND start_date < (now() + interval '1 day')";
    query += " AND last_update IS NOT NULL";
    query += " AND earth_box(ll_to_earth("+lat+", "+lon+"), 60000) @> ll_to_earth(events.latitude, events.longitude)";
    query += " ORDER BY people DESC LIMIT " + limit;
    extractFromDb(query, cb);
}
*/
function retrieveEventsInBox(bottomRight, topLeft, cb) {
    var query = "";
    query += "SELECT name, start_date AS start_time, attending_total AS people, location, latitude, longitude, eid ";
    query += "FROM events WHERE";
    query += " start_date >= now()::date AND start_date < (now()::date + interval '" + dateRangeToDisplay + "')";
    query += " AND last_update IS NOT NULL";
    query += " AND latitude > " + bottomRight.latitude;
    query += " AND latitude < " + topLeft.latitude;
    query += " AND longitude < " + bottomRight.longitude;
    query += " AND longitude > " + topLeft.longitude;
    query += " ORDER BY people DESC LIMIT " + numberOfEventsToRetrieve;
    extractFromDb(query, cb);
}

function extractFromDb(queryString, cb) {
    var results = [];
    pg.connect(process.env.DATABASE_URL, function(error, client, done) {
        if(error) {
            console.log(error);
            return;
        }
        var query = client.query(queryString);
        query.on('error', function(error) {
            console.log(error);
        });
        query.on('row', function(row) {
            results.push(row);
        });
        query.on('end', function(result) {
            done();
            cb(results); 
        });
    });
};

function retrieveEventInfo(eid, tok, cb) {
    console.log('Retrieving info about event ' + eid);
    var query = "{"+
                    "\"theevent\":\"select eid, name, attending_count, unsure_count, location, venue.id, start_time, end_time from event where eid='"+eid+"'\"," +
                    "\"thevenue\":\"select location.latitude, location.longitude from page where page_id in (select venue.id from #theevent )\"" + 
                "}";    
	executeFbQuery(query, tok, cb);
}

function retrieveEventGirls(eid, tok) {
    console.log('Contacting FB to retrieve info about event ' + eid);
    query = "select '' from user where sex = 'female' and uid in (select uid from event_member where eid ='"+eid+"' and rsvp_status = 'attending')";
	return executeFbQuery_HeadOnly(query, tok);
}

app.get('/update', function (req, res) {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end();
    doTheBigUpdate();
});

function updateEventInfo(eventData) {
    var query = "UPDATE events SET end_date=$1, attending_total=$2, maybe_total=$3, latitude=$4, longitude=$5, location=$6, name=left($7, 100), last_update = now() WHERE eid = $8;";
    updateIntoDb(query, eventData);
}

function asyncRetrieve(eventRows, token) {
    async.eachLimit(eventRows, parallelAsyncHttpRequests, function(eventRow, cb) {
        retrieveEventInfo(eventRow.eid, token, function(fbData) {
            console.log('Retrieved fields for event ' + eventRow.eid);
            try{
                var data = fbData.data;
                var eventData = [
                    data[0].fql_result_set[0].end_time,
                    data[0].fql_result_set[0].attending_count,
                    data[0].fql_result_set[0].unsure_count,                    
                    (data[1].fql_result_set[0]) ? data[1].fql_result_set[0].location.latitude : null,
                    (data[1].fql_result_set[0]) ? data[1].fql_result_set[0].location.longitude : null,
                    data[0].fql_result_set[0].location,
                    data[0].fql_result_set[0].name,
                    data[0].fql_result_set[0].eid                    
                 ];
                 updateEventInfo(eventData);
                 cb();
             } catch(err) {
                cb(err);
             }
        });
    }, function(err) {
        if (err) {
            console.log('Retrieve problem:' +err);
        }
    });
}

var token;
var last_check;
function getAToken() {
    // if (now - last_check > 20 minutes)
    var threshold = moment().subtract('minutes', askParseANewTokenAfterXMinutes);
    if(last_check == undefined || threshold > last_check) {
        console.log('Retrieving new token from Parse');
        var FacebookUser = Parse.Object.extend("FacebookUser");
	    var query = new Parse.Query(FacebookUser);
	    query.descending("updatedAt")
	    token = query.first();
	    last_check = moment();
    }
    return token;
}

function doTheBigUpdate() {
    extractFromDb("delete from events where start_date < now()::date - interval '"+ deleteEventsOlderThan +"'", function(nvm) {});
    retrieveEventsToUpdate(function(eventRows) {
        console.log('Number of events to update: ' + eventRows.length);
        getAToken().then(function(user) {asyncRetrieve(eventRows, user.get("token"));});
    });
}

function retrieveEventsToUpdate(cb) {
    var limit = maxEventsToUpdate;
    console.log('Retrieving events to update');
    var query= "SELECT eid FROM events where ((last_update < (now() - INTERVAL '"+ updateEventEveryXHours +" hours')) or last_update IS NULL) and start_date > now() ORDER BY last_update ASC LIMIT " + limit;
    extractFromDb(query, cb);
};
