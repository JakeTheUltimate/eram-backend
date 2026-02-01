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

app.use(express.static(__dirname));

// --- API CONFIG ---
const RELAY_BASE_URL = "https://ws.awdevsoftware.org";
const FPL_API_BASE_URL = "https://ws.awdevsoftware.org";
const CONTROLLER_API = "https://ws.awdevsoftware.org/controllers";

let globalPlanes = {}; 

// --- SINGLE SOCKET CONNECTION BLOCK ---
io.on('connection', (socket) => {
    console.log(`User Connected: ${socket.id}`);

    // Home Page Sector Check
    socket.on('checkAvailability', async () => {
        try {
            const response = await axios.get(CONTROLLER_API);
            const data = response.data;
            const sectors = ["IRCC", "ICCC", "IZCC", "IOCC", "IPCC", "IBCC", "IGCC", "ISCC"];
            const status = {};

            sectors.forEach(code => {
                const match = data.find(c => c.airport === code && c.position === "CTR");
                status[code] = match ? { taken: true, holder: match.holder } : { taken: false };
            });
            socket.emit('availabilityStatus', status);
        } catch (err) {
            console.error("API Error (Availability):", err.message);
        }
    });

    // Manual Update from Bridge (if used)
    socket.on('updateData', async (data) => {
        if (!data || !data.playerName) return;
        data.lastUpdate = Date.now();
        data.isCoasting = false; 
        globalPlanes[data.callsign || data.playerName] = data;
        io.emit('radarUpdate', globalPlanes);
    });

    socket.on('updateFPLField', async (payload) => {
        const { robloxName, field, value } = payload;
        try {
            await axios.patch(`${FPL_API_BASE_URL}/fpls/${robloxName}`, { [field]: value });
        } catch (err) {
            console.error("❌ Amendment Failed:", err.message);
        }
    });

    // --- HANDOFF LISTENERS (MOVED INSIDE CONNECTION BLOCK) ---
    socket.on('initiateHandoff', (payload) => {
        const { callsign, targetSector } = payload;
        if (globalPlanes[callsign]) {
            globalPlanes[callsign].handoffTarget = targetSector;
            io.emit('radarUpdate', globalPlanes);
        }
    });

    socket.on('acceptHandoff', (payload) => {
        const { callsign } = payload;
        if (globalPlanes[callsign]) {
            globalPlanes[callsign].handoffTarget = null;
            io.emit('radarUpdate', globalPlanes);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User Disconnected: ${socket.id}`);
    });
});

// --- THE TWO-STAGE JANITOR ---
setInterval(() => {
    const now = Date.now();
    let updated = false;
    for (const callsign in globalPlanes) {
        const ac = globalPlanes[callsign];
        const age = now - ac.lastUpdate;
        if (age > 10000 && !ac.isCoasting) {
            ac.isCoasting = true;
            updated = true;
        }
        if (age > 15000) {
            delete globalPlanes[callsign];
            updated = true;
        }
    }
    if (updated) io.emit('radarUpdate', globalPlanes);
}, 2000);

// --- BULLETPROOF POLLING LOGIC ---
setInterval(async () => {
    try {
        const [acftRes, fplsRes] = await Promise.all([
            axios.get(`${RELAY_BASE_URL}/acft-data`),
            axios.get(`${RELAY_BASE_URL}/fpls`)
        ]);

        const acftData = acftRes.data; 
        const allFpls = fplsRes.data;

        // Inside your setInterval(async () => { ... }, 1000)

for (const key in acftData) {
    const raw = acftData[key];
    if (!raw || !raw.position) continue;

    const pilot = raw.playerName; // This is the Roblox Username
    const actualCallsign = raw.callsign || key;
    
    let foundFpl = null;
    if (Array.isArray(allFpls)) {
        // Look for the FPL by Roblox Username first, then callsign
        foundFpl = allFpls.find(f => f.robloxName === pilot || f.callsign === actualCallsign);
    }

    const existing = globalPlanes[actualCallsign];
    
    // Keep the FLID consistent so it doesn't change every second
    const flid = (existing && existing.flid) ? existing.flid : Math.floor(Math.random() * 899 + 100).toString();
    
    // Keep the same squawk unless it's a brand new FPL
    const squawk = (existing && existing.flightPlan && existing.flightPlan.squawk) 
        ? existing.flightPlan.squawk 
        : generateOctalSquawk();

    // UPDATE: Always overwrite flightPlan with foundFpl to ensure it's not out of date
    globalPlanes[actualCallsign] = {
        ...raw,
        callsign: actualCallsign,
        playerName: pilot,
        position: { x: Number(raw.position.x), y: Number(raw.position.y) },
        altitude: Number(raw.altitude || 0),
        groundSpeed: Number(raw.groundSpeed || 0),
        heading: Number(raw.heading || 0),
        lastUpdate: Date.now(),
        isCoasting: false,
        flid: flid,
        handoffTarget: (existing && existing.handoffTarget) ? existing.handoffTarget : null,
        flightPlan: foundFpl ? {
            ...foundFpl, // This spreads the NEWEST data from the API
            dest: foundFpl.arriving,
            dep: foundFpl.departing,
            type: foundFpl.aircraft,
            level: foundFpl.flightlevel,
            squawk: squawk 
        } : { dest: "VFR", squawk: squawk }
    };
}
        io.emit('radarUpdate', globalPlanes);
    } catch (e) { /* Silent catch */ }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ERAM Engine active on port ${PORT}`));