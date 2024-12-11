const { Gpio } = require('onoff');
const express = require('express');
const cron = require('node-cron');
const port = 3000;
const dotenv = require('dotenv');
const fs = require('fs');
const app = express();
dotenv.config();

const leds = {};
const activeSchedules = {};
const manualOverride = {};  // Tracks if manual override happened
const manualDuringSchedule = {};  // Tracks if manual override happened during the schedule
const portToPinMap = {
    1: 526,
    2: 527,
    3: 530,
    4: 535,
    5: 536,
    6: 537
};

const gpioPins = {};
const validKey = process.env.VALID_KEY;

// Load relay states from JSON file (also load scheduleStart and scheduleEnd)
const loadRelayStates = () => {
    if (fs.existsSync('relayStates.json')) {
        const relayStates = JSON.parse(fs.readFileSync('relayStates.json', 'utf-8'));

        relayStates.forEach(relay => {
            // Initialize the GPIO pins
            const pin = new Gpio(portToPinMap[relay.port], 'out');
            gpioPins[relay.port] = pin;
            pin.writeSync(relay.state === 'on' ? 0 : 1);
            manualOverride[relay.port] = false;
            manualDuringSchedule[relay.port] = false; // Initialize to false

            // Recreate schedules if they exist
            if (relay.scheduleStart && relay.scheduleEnd) {
                const [startHour, startMinute] = relay.scheduleStart.split(':').map(Number);
                const [endHour, endMinute] = relay.scheduleEnd.split(':').map(Number);

                const turnOnSchedule = cron.schedule(`${startMinute} ${startHour} * * *`, () => {
                    // Always turn on at scheduled time unless manually turned off during this cycle
                    if (!manualDuringSchedule[relay.port]) {
                        pin.writeSync(0);  // Turn on
                        console.log(`Scheduled turn on for port ${relay.port}`);
                    } else {
                        console.log(`Manual override during scheduled period for port ${relay.port}, skipping turn on.`);
                    }
                    saveRelayStates();
                });

                const turnOffSchedule = cron.schedule(`${endMinute} ${endHour} * * *`, () => {
                    pin.writeSync(1);  // Turn off
                    manualOverride[relay.port] = false;  // Reset after scheduled period
                    manualDuringSchedule[relay.port] = false;  // Reset after scheduled period
                    saveRelayStates();
                    console.log(`Scheduled turn off for port ${relay.port}`);
                });

                activeSchedules[relay.port] = {
                    turnOnSchedule,
                    turnOffSchedule,
                    startTime: relay.scheduleStart,
                    endTime: relay.scheduleEnd
                };
            }
        });

        return relayStates;
    } else {
        return Object.keys(portToPinMap).map(port => ({ port: parseInt(port), state: 'off' }));
    }
};

// Save relay states and schedule information
const saveRelayStates = () => {
    const relayStates = Object.keys(portToPinMap).map(port => {
        const pin = gpioPins[port];
        const state = pin.readSync() === 0 ? 'on' : 'off';

        // Get scheduleStart and scheduleEnd if available in activeSchedules
        const schedule = activeSchedules[port] || {};
        const scheduleStart = schedule.startTime || null;
        const scheduleEnd = schedule.endTime || null;

        return {
            port: parseInt(port),
            state,
            scheduleStart,
            scheduleEnd
        };
    });

    fs.writeFileSync('relayStates.json', JSON.stringify(relayStates, null, 2));
};

// Initialize relays based on loaded states
const initializeRelays = () => {
    loadRelayStates();
};

initializeRelays();

// Manual control of LED (turn on/off)
app.get('/led/:port/:state', (req, res) => {
    const portNumber = parseInt(req.params.port);
    const state = req.params.state;
    const providedKey = req.headers['x-api-key'];

    if (providedKey !== validKey) {
        return res.status(403).send('Invalid key');
    }

    const pin = gpioPins[portNumber];
    manualOverride[portNumber] = true; // Manual control happened
    const currentTime = new Date();
    const currentHour = currentTime.getHours();
    const currentMinute = currentTime.getMinutes();

    // Check if the manual action is happening during the schedule
    const schedule = activeSchedules[portNumber];
    if (schedule && schedule.startTime && schedule.endTime) {
        const [startHour, startMinute] = schedule.startTime.split(':').map(Number);
        const [endHour, endMinute] = schedule.endTime.split(':').map(Number);

        if (
            (currentHour > startHour || (currentHour === startHour && currentMinute >= startMinute)) &&
            (currentHour < endHour || (currentHour === endHour && currentMinute <= endMinute))
        ) {
            // Mark that a manual override happened during the schedule period
            manualDuringSchedule[portNumber] = true;
        }
    }

    if (state === 'on') {
        pin.writeSync(0);
        saveRelayStates();
        res.json({
            port: portNumber,
            state: 'on',
            message: `LED on port ${portNumber} turned on manually`
        });
    } else {
        pin.writeSync(1);
        saveRelayStates();
        res.json({
            port: portNumber,
            state: 'off',
            message: `LED on port ${portNumber} turned off manually`
        });
    }
});

// Schedule control for LED (set start and end times)
app.get('/schedule/:port/:start/:end', (req, res) => {
    const portNumber = parseInt(req.params.port);
    const startTime = req.params.start;
    const endTime = req.params.end;
    const providedKey = req.headers['x-api-key'];

    if (providedKey !== validKey) {
        return res.status(403).send('Invalid key');
    }

    if (!portToPinMap[portNumber]) {
        return res.status(400).send('Invalid port number');
    }

    const pin = gpioPins[portNumber];

    // Stop existing schedule if 'null' is passed
    if (startTime === 'null' && endTime === 'null') {
        if (activeSchedules[portNumber]) {
            activeSchedules[portNumber].turnOnSchedule.stop();
            activeSchedules[portNumber].turnOffSchedule.stop();
            delete activeSchedules[portNumber];
            saveRelayStates();
            return res.json({ port: portNumber, from: null, to: null, message: `Schedule for LED on port ${portNumber} has been stopped.` });
        } else {
            return res.json({ from: null, to: null, message: `No active schedule found for port ${portNumber}.` });
        }
    }

    // Stop existing schedule before creating a new one
    if (activeSchedules[portNumber]) {
        activeSchedules[portNumber].turnOnSchedule.stop();
        activeSchedules[portNumber].turnOffSchedule.stop();
        delete activeSchedules[portNumber];
    }

    const [startHour, startMinute] = startTime.split(':').map(Number);
    const [endHour, endMinute] = endTime.split(':').map(Number);

    const turnOnSchedule = cron.schedule(`${startMinute} ${startHour} * * *`, () => {
        // Always turn on at scheduled time unless manually turned off during this cycle
        if (!manualDuringSchedule[portNumber]) {
            pin.writeSync(0);  // Turn on
            console.log(`Scheduled turn on for port ${portNumber}`);
        } else {
            console.log(`Manual override during scheduled period for port ${portNumber}, skipping turn on.`);
        }
        saveRelayStates();
    });

    const turnOffSchedule = cron.schedule(`${endMinute} ${endHour} * * *`, () => {
        pin.writeSync(1);  // Turn off
        manualOverride[portNumber] = false;  // Reset after scheduled period
        manualDuringSchedule[portNumber] = false;  // Reset after scheduled period
        saveRelayStates();
        console.log(`Scheduled turn off for port ${portNumber}`);
    });

    activeSchedules[portNumber] = {
        turnOnSchedule,
        turnOffSchedule,
        startTime,
        endTime
    };

    // Save the new schedule to relayStates.json
    saveRelayStates();

    res.json({ port: portNumber, from: startTime, to: endTime, message: `Scheduled LED on port ${portNumber} from ${startTime} to ${endTime} every day.` });
});

// Get the current relay states
app.get('/relays', (req, res) => {
    const providedKey = req.headers['x-api-key'];

    if (providedKey !== validKey) {
        return res.status(403).send('Invalid key');
    }

    const relayStates = Object.keys(portToPinMap).map(port => {
        const pin = gpioPins[port];
        const state = pin.readSync() === 0 ? 'on' : 'off';
        return { port: parseInt(port), state };
    });

    res.json(relayStates);
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
