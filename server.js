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
// --- BULLETPROOF POLLING LOGIC (FIXED) ---
setInterval(async () => {
    try {
        const [acftRes, fplsRes] = await Promise.all([
            axios.get(`${RELAY_BASE_URL}/acft-data`).catch(() => ({ data: {} })),
            axios.get(`${RELAY_BASE_URL}/fpls`).catch(() => ({ data: [] }))
        ]);

        const acftData = acftRes.data || {}; 
        const allFpls = Array.isArray(fplsRes.data) ? fplsRes.data : [];

        // If no aircraft data, don't clear the screen yet, just wait for next tick
        if (Object.keys(acftData).length === 0) return;

        for (const key in acftData) {
            const raw = acftData[key];
            if (!raw || !raw.position) continue;

            const pilot = raw.playerName || "Unknown";
            const actualCallsign = raw.callsign || key;
            
            // Correlation Logic: Look for the newest FPL by Roblox Name
            let foundFpl = allFpls.find(f => f.robloxName === pilot || f.callsign === actualCallsign);

            const existing = globalPlanes[actualCallsign];
            const flid = (existing && existing.flid) ? existing.flid : Math.floor(Math.random() * 899 + 100).toString();
            const handoff = (existing && existing.handoffTarget) ? existing.handoffTarget : null;

            // Generate Squawk helper inside scope
            function generateOctalSquawk() {
                const forbidden = ['1200', '7500', '7600', '7700'];
                let sq;
                do {
                    sq = Array.from({ length: 4 }, () => Math.floor(Math.random() * 8)).join('');
                } while (forbidden.includes(sq));
                return sq;
            }

            const squawk = (existing && existing.flightPlan && existing.flightPlan.squawk) 
                ? existing.flightPlan.squawk 
                : generateOctalSquawk();

            // Reconstruct the plane object
            globalPlanes[actualCallsign] = {
                ...raw,
                callsign: actualCallsign,
                playerName: pilot,
                position: { 
                    x: raw.position.x !== undefined ? Number(raw.position.x) : 0, 
                    y: raw.position.y !== undefined ? Number(raw.position.y) : 0 
                },
                altitude: Number(raw.altitude || 0),
                groundSpeed: Number(raw.groundSpeed || 0),
                heading: Number(raw.heading || 0),
                lastUpdate: Date.now(),
                isCoasting: false,
                flid: flid,
                handoffTarget: handoff,
                flightPlan: foundFpl ? {
                    ...foundFpl,
                    dest: foundFpl.arriving || "UNK",
                    dep: foundFpl.departing || "UNK",
                    type: foundFpl.aircraft || "UNK",
                    level: foundFpl.flightlevel || "000",
                    squawk: squawk 
                } : { dest: "VFR", squawk: squawk }
            };
        }
        io.emit('radarUpdate', globalPlanes);
    } catch (e) {
        console.error("Critical Poller Error:", e.message);
    }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ERAM Engine active on port ${PORT}`));