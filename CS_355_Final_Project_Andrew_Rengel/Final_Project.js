const http = require('http');
const fs = require('fs');
const url = require('url');
const https = require('https');
const querystring = require('querystring');


const port = 3000;
const server = http.createServer();
let user_input
const {client_id_event, client_secret_event, client_id_cal, client_secret_cal} = require("./credentials.json");

server.on("request", connection_handler);



function connection_handler(req, res){
    console.log(`New Request for ${req.url} from ${req.socket.remoteAddress}`);
    
    if (req.url === "/"){
        server_home_page(res);
    }
    else if (req.url.startsWith("/submit")){
        const filename = `./cache_event.json`;
        if (fs.existsSync(filename)){ //Caching for EventBrite Token. (Never expires therefore, create once and never again)
            const access_token = fs.readFileSync(filename, "utf-8");
            if(access_token){
                console.log("Using cached EventBrite token.\n")
                user_input = url.parse(req.url, true).query;
                console.log (user_input);
                user_input.start = convert_local_to_utc(user_input.date + "T" + user_input.start + ":00"); //Changes time to correct format
                user_input.end = convert_local_to_utc(user_input.date + "T" + user_input.end + ":00"); //Changes time to correct format
                get_organization_id(access_token, res); //Creating an event in EventBrite requires the use of your organization id
            }   
        } else {
            handle_form_submission(req, res);
        }
    }
    else if (req.url.startsWith ("/callback")){
        handle_eventbrite_callback(req, res);
    }
    else if (req.url.startsWith("/redirect_to_google")){
        handle_google_callback(req, res);
    }
    else {
        server_not_found(res);
    }
}

function server_home_page(res){
    const form = fs.createReadStream("main.html");
    res.writeHead(200, {"Content-Type": "text/html"})
    form.pipe(res);
}

function handle_form_submission(req, res){
    user_input = url.parse(req.url, true).query;
    console.log (user_input);
    user_input.start = convert_local_to_utc(user_input.date + "T" + user_input.start + ":00"); //Changes time to correct format
    user_input.end = convert_local_to_utc(user_input.date + "T" + user_input.end + ":00"); //Changes time to correct format
    console.log(user_input.Event_Name + user_input.start + user_input.end);
    res.writeHead(302, {"Location":`https://www.eventbrite.com/oauth/authorize?response_type=code&client_id=${client_id_event}&redirect_uri=http://localhost:${port}/callback`})//Assume User is already logged in (Error with EventBrite API)
    res.end()
}

function handle_eventbrite_callback(req, res){
    console.log("Handling EventBrite Callback");
    const {code} = url.parse(req.url,true).query;
    console.log(code);
    const post_data = querystring.stringify({
        client_id: client_id_event,
        client_secret: client_secret_event,
        code,
        grant_type: "authorization_code",
        redirect_uri: "http://localhost:3000/callback"
    });
    let options = {
        method: "POST",
        headers:{
            "Content-type": "application/x-www-form-urlencoded"
        }
    }
    const req_stream = https.request(
        "https://www.eventbrite.com/oauth/token",
        options,
        (response_stream) => process_stream(response_stream, receive_access_token_eventbrite, res)
    )
    req_stream.write(post_data);
    req_stream.end();
}

function process_stream (stream, callback , ...args){
	let body = "";
	stream.on("data", chunk => body += chunk);
	stream.on("end", () => callback(body, ...args));
}

function receive_access_token_eventbrite(body, res){
    console.log("Fetching new EventBrite token.\n")
    let token_object = JSON.parse(body);
    console.log(token_object);
    const access_token = token_object.access_token;
    console.log(access_token);
    fs.writeFileSync(`./cache_event.json`, access_token)
    get_organization_id(access_token, res); //Creating an event in EventBrite requires the use of your organization id
}

function get_organization_id(access_token, res){
    let options = {
        method: "GET",
        headers: {
            Authorization: `Bearer ${access_token}`
        }
    }
    https.request(
        "https://www.eventbriteapi.com/v3/users/me/organizations/",
        options,
        (response_stream) => process_stream(response_stream, handle_organization_response, access_token, res)
    ).end();
}

function handle_organization_response(body, access_token, res){
    const parsed_data = JSON.parse(body);
    console.log(parsed_data.organizations);
    const organization_id = parsed_data.organizations[0].id;
    create_event(access_token, organization_id, user_input, res)
}

function create_event(access_token, organization_id, user_input, res){
    let options = {
        method: "POST",
        headers: {
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json"
        }
    }
    const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    console.log("Sending Request to EventBrite API...");
    const req = https.request(
        `https://www.eventbriteapi.com/v3/organizations/${organization_id}/events/`,
        options,
        (response_stream) => {
            let body = "";
            response_stream.on("data", (chunk) => {
                body += chunk;
            })
            response_stream.on("end", () => {
                const parsed_response = JSON.parse(body);
                console.log("Event Created Respones:" , parsed_response);
                redirect_to_google(res); //Allows for synchronous behavior (callback chaining)
            })
        }
    );
    req.write(JSON.stringify({
        event: {
            name: { html: user_input.Event_Name},
            start: {
                timezone: userTimeZone, 
                utc: user_input.start 
            },
            end: {
                timezone: userTimeZone,
                utc: user_input.end 
            },
            currency: "USD" // Required field
        }
    }));
    req.end();
}

function redirect_to_google(res){
    const filename = `./cache_cal.json`
    if (fs.existsSync(filename)){ // Caching for Google Calendar (Does expire therefore need to compare to current time)
        const file_data = JSON.parse(fs.readFileSync(filename, 'utf-8'));
        if (Date.now() < file_data.expiry){
            console.log("Using cached Google Token.");
            add_to_calendar(file_data.access_token, res)
        }else{
            console.log("Cached Access Token is expired.\n")
            fs.unlinkSync(filename);
            res.writeHead(302, {"Location": `https://accounts.google.com/o/oauth2/v2/auth?client_id=${client_id_cal}&redirect_uri=http://localhost:${port}/redirect_to_google&response_type=code&scope=https://www.googleapis.com/auth/calendar.events&access_type=offline`});
            res.end();   
        }
    } else {
        console.log("Inside redirect_to_google");
        res.writeHead(302, {"Location": `https://accounts.google.com/o/oauth2/v2/auth?client_id=${client_id_cal}&redirect_uri=http://localhost:${port}/redirect_to_google&response_type=code&scope=https://www.googleapis.com/auth/calendar.events&access_type=offline`});
        res.end(); 
    }
}

function handle_google_callback(req, res){
    const {code} = url.parse(req.url,true).query;
    console.log(code);
    const post_data = querystring.stringify({
        code: code,
        client_id: client_id_cal,
        client_secret: client_secret_cal,
        redirect_uri: "http://localhost:3000/redirect_to_google",
        grant_type: "authorization_code"
    });
    let options = {
        method: "POST",
        headers:{
            "Content-type": "application/x-www-form-urlencoded"
        }
    }
    https.request(
        "https://oauth2.googleapis.com/token",
        options,
        (response_stream) => process_stream(response_stream, receive_access_token_cal, res)
    ).end(post_data);
}

function receive_access_token_cal(body, res){
    console.log("Raw Response from Google Token Exchange:", body);
    try {
        const parsed_body = JSON.parse(body);
        if (parsed_body.error) {
            console.error("Error in Token Exchange:", parsed_body.error);
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Failed to retrieve Google access token.");
            return;
        }
        console.log(parsed_body);
        const { access_token } = parsed_body;
        console.log("Fetching new Google token.\n")
        if (access_token) { //Adds to cache first and then adds to calendar
            const filename = `./cache_cal.json` 
            let token_object = JSON.parse(body);
            console.log(token_object);
            const access_token = token_object.access_token;
            const expiryTimestap = Date.now() + token_object.expires_in * 1000;
            console.log(access_token);
            const cacheData = {
                access_token,
                expiry: expiryTimestap
            }
            fs.writeFileSync(filename, JSON.stringify(cacheData));
            add_to_calendar(access_token, res);
        } else {
            console.error("Access token missing in Google response.");
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Access token not found.");
        }
    } catch (err) {
        console.error("Failed to parse Google token response:", err);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Invalid response from Google Token API.");
    }
}

function add_to_calendar(access_token, res){
    const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;   
    console.log("User input for Google Calendar:", user_input); // ENSURE DATE TIME IS VALID FORMAT
    const event_data = JSON.stringify({
        summary: user_input.Event_Name,
        start: {
            dateTime: user_input.start,
            timeZone: userTimeZone,
        },
        end: {
            dateTime: user_input.end,
            timeZone: userTimeZone,
        }
    });
    let options = {
        method: "POST",
        headers: {
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json"
        }
    }
    console.log("Sending Request to Google Calendar API...");

    const req = https.request(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events`,
        options,
        (response_stream) => {
            let body = "";
            response_stream.on("data", (chunk) => {
                body += chunk;
            })
            response_stream.on("end", () => {
                const parsed_response = JSON.parse(body);
                console.log("Event Created Respones:" , parsed_response);
                // Check for errors in response
                if (parsed_response.error) {
                    console.error("Error from Google Calendar:", parsed_response.error);
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(parsed_response.error));
                } else {
                    console.log("Event Successfully Created in Google Calendar!");
                    res.writeHead(302, {Location: `${parsed_response.htmlLink}`}).end()
                }
            });
        }
    );
    // Handle network-level errors
    req.on("error", (err) => {
        console.error("Error sending request to Google Calendar API:", err);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Failed to add event to Google Calendar.");
    });
    req.write(event_data);
    req.end();
}

function convert_local_to_utc(local_timezone){
    const localDate = new Date(local_timezone);
    const utcYear = localDate.getUTCFullYear();
    const utcMonth = String(localDate.getUTCMonth() + 1).padStart(2, "0");
    const utcDay = String(localDate.getUTCDate()).padStart(2, "0");
    const utcHours = String(localDate.getUTCHours()).padStart(2, "0");
    const utcMinutes = String(localDate.getUTCMinutes()).padStart(2, "0");
    const utcSeconds = String(localDate.getUTCSeconds()).padStart(2, "0");
    return (`${utcYear}-${utcMonth}-${utcDay}T${utcHours}:${utcMinutes}:${utcSeconds}Z`);
}

function server_not_found(res){
    res.writeHead(404, {"Content-Type":"text/plain"});
    res.write("404 Not Found", () => res.end());
}

server.on("listening", listening_handler);
function listening_handler(){
    console.log(`Now Listening on Port ${port}`)
}

server.listen(port);