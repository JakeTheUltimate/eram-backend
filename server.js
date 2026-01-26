const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['polling', 'websocket']
});

// --- API CONFIG ---
const RELAY_BASE_URL = "https://ws.awdevsoftware.org";
const FPL_API_BASE_URL = "https://ws.awdevsoftware.org";

let globalPlanes = {}; 

// --- THE TWO-STAGE JANITOR (CLEANS SCREEN ONLY) ---
setInterval(() => {
    const now = Date.now();
    let updated = false;

    for (const callsign in globalPlanes) {
        const ac = globalPlanes[callsign];
        const age = now - ac.lastUpdate;

        // Stage 1: Coasting (10s no data)
        if (age > 10000 && !ac.isCoasting) {
            ac.isCoasting = true;
            updated = true;
        }

        // Stage 2: Remove from radar (15s no data)
        if (age > 15000) {
            delete globalPlanes[callsign];
            updated = true;
        }
    }

    if (updated) io.emit('radarUpdate', globalPlanes);
}, 2000);

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    console.log(`User Connected: ${socket.id}`);

    // Receive radar data from Roblox Bridge
    socket.on('updateData', async (data) => {
        if (!data || !data.playerName) return;

        // Fetch flight plan from your database
        try {
            const response = await axios.get(`${FPL_API_BASE_URL}/fpls/${data.playerName}`);
            data.flightPlan = response.data; 
        } catch (err) {
            data.flightPlan = null;
        }

        data.lastUpdate = Date.now();
        data.isCoasting = false; 
        globalPlanes[data.callsign || data.playerName] = data;
        
        io.emit('radarUpdate', globalPlanes);
    });

    // Handle Amendments (AM Commands)
    socket.on('updateFPLField', async (payload) => {
        const { robloxName, field, value } = payload;
        try {
            await axios.patch(`${FPL_API_BASE_URL}/fpls/${robloxName}`, {
                [field]: value
            });
            console.log(`✅ ${field} updated for ${robloxName}`);
        } catch (err) {
            console.error("❌ Amendment Failed:", err.message);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User Disconnected: ${socket.id}`);
    });
});

// --- NEW DATA POLLING LOGIC ---
// This hits the relay endpoints you provided every second
// --- NEW DATA POLLING LOGIC (CORRECTED MAPPING) ---
// --- NEW DATA POLLING LOGIC (STRICT MAPPING) ---
// --- BULLETPROOF POLLING LOGIC ---
setInterval(async () => {
    try {
        const [acftRes, fplsRes] = await Promise.all([
            axios.get(`${RELAY_BASE_URL}/acft-data`),
            axios.get(`${RELAY_BASE_URL}/fpls`)
        ]);

        const acftData = acftRes.data; 
        const allFpls = fplsRes.data;

       for (const key in acftData) {
    const raw = acftData[key];
    if (!raw || !raw.position) continue;

    const pilot = raw.playerName;
    const actualCallsign = raw.callsign || key;

    let foundFpl = null;
    if (Array.isArray(allFpls)) {
        foundFpl = allFpls.find(f => f.robloxName === pilot || f.callsign === actualCallsign);
    }

    function generateOctalSquawk() {
    const forbidden = ['1200', '7500', '7600', '7700'];
    let squawk;
    do {
        // Generates 4 digits, each between 0-7
        squawk = Array.from({ length: 4 }, () => Math.floor(Math.random() * 8)).join('');
    } while (forbidden.includes(squawk));
    return squawk;
}

    // PERSISTENT RANDOM FLID (3-digit)
    const existing = globalPlanes[actualCallsign];
    const flid = (existing && existing.flid) ? existing.flid : Math.floor(Math.random() * 899 + 100).toString();

    // PERSISTENT OCTAL SQUAWK (4-digit, 0-7, avoids restricted)
    const squawk = (existing && existing.flightPlan && existing.flightPlan.squawk) 
        ? existing.flightPlan.squawk 
        : generateOctalSquawk();

    globalPlanes[actualCallsign] = {
        ...raw,
        callsign: actualCallsign,
        playerName: pilot,
        position: {
            x: Number(raw.position.x),
            y: Number(raw.position.y)
        },
        altitude: Number(raw.altitude || 0),
        groundSpeed: Number(raw.groundSpeed || 0),
        heading: Number(raw.heading || 0),
        lastUpdate: Date.now(),
        isCoasting: false,
        flid: flid,

        flightPlan: foundFpl ? {
            ...foundFpl,
            dest: foundFpl.arriving,
            dep: foundFpl.departing,
            type: foundFpl.aircraft,
            level: foundFpl.flightlevel,
            squawk: squawk // Use the octal squawk here
        } : { 
            dest: "VFR", 
            squawk: squawk // Even VFR gets the randomized octal
        }
    };
}

        
        io.emit('radarUpdate', globalPlanes);
        
        // --- ADDED THIS FOR YOU TO VERIFY IN TERMINAL ---
        const count = Object.keys(globalPlanes).length;
        if(count > 0) {
            const first = Object.keys(globalPlanes)[0];
            console.log(`Tracking ${count} acft. Example [${first}]: X:${globalPlanes[first].position.x} Y:${globalPlanes[first].position.y}`);
        }

    } catch (e) {
        // Silent catch
    }
}, 1000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ERAM Engine active on port ${PORT}`));