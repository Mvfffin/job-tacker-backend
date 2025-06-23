// In backend/server.js - FINAL version with consistent .lean() responses

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const Job = require('./models/Job');
const { Client } = require("@googlemaps/google-maps-services-js");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.options('*', cors());
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

// Initialize Google Maps Client
const mapsClient = new Client({});

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Successfully connected to MongoDB Atlas!'))
  .catch((error) => console.error('Error connecting to MongoDB:', error));

// --- API ROUTES ---

app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await Job.find().sort({ collectionTime: 1 }).lean();
    res.json(jobs);
  } catch (error) { res.status(500).json({ message: 'Error fetching jobs', error }); }
});

app.post('/api/jobs', async (req, res) => {
  try {
    const newJob = new Job({ ...req.body, collectionTime: new Date(req.body.collectionTime), status: 'Scheduled' });
    const savedJob = await newJob.save();
    const jobToReturn = await Job.findById(savedJob._id).lean(); // Use .lean() here too
    res.status(201).json(jobToReturn);
  } catch (error) {
    if (error.code === 11000) { return res.status(400).json({ message: 'This Reference Number already exists.' }); }
    res.status(400).json({ message: 'Error creating job', error });
  }
});

app.post('/api/jobs/upload', (req, res) => {
    // This route does not return job objects, so no .lean() is needed here.
    const results = [];
    const filePath = req.file.path;
    fs.createReadStream(filePath)
        .pipe(csv({
        mapHeaders: ({ header }) => {
            switch (header.toLowerCase().trim()) {
            case 'reference number': return 'referenceNumber'; case 'customer': return 'customerName'; case 'driver': return 'driverName';
            case 'collection address': return 'collectionAddress'; case 'delivery address': return 'deliveryAddress';
            case 'collection time': return 'collectionTime'; case 'notes': return 'notes';
            default: return null;
            }
        }
        }))
        .on('data', (data) => {
        if (data.referenceNumber && data.customerName && data.driverName && data.collectionAddress && data.deliveryAddress && data.collectionTime) {
            const collectionDate = new Date(data.collectionTime);
            if (!isNaN(collectionDate.getTime())) {
                results.push({ ...data, collectionTime: collectionDate, status: 'Scheduled' });
            } else {
                console.warn(`Skipping row with invalid date for Reference [${data.referenceNumber}]. Invalid value: "${data.collectionTime}"`);
            }
        }
        })
        .on('end', async () => {
        fs.unlinkSync(filePath);
        if (results.length > 0) {
            try {
            if (req.body.replace === 'true') { await Job.deleteMany({}); }
            await Job.insertMany(results);
            res.status(201).send(`${results.length} jobs successfully uploaded.`);
            } catch (error) {
            if (error.code === 11000) { return res.status(400).json({ message: 'Upload failed. One or more Reference Numbers already exist.' }); }
            res.status(500).json({ message: 'Error saving jobs', error });
            }
        } else {
            res.status(400).send('CSV file was empty or did not contain valid rows.');
        }
        });
});

app.put('/api/jobs/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const update = { status };
    switch (status) {
      case 'En route to collection': update.timeEnRouteToCollection = new Date(); break;
      case 'Onsite at collection': update.timeArrivedAtCollection = new Date(); break;
      case 'Loaded':
        update.timeLoaded = new Date();
        const job = await Job.findById(req.params.id);
        const request = {
          params: {
            origins: [job.collectionAddress], destinations: [job.deliveryAddress],
            departure_time: 'now', key: process.env.Maps_API_KEY,
          },
        };
        const response = await mapsClient.distancematrix(request);
        if (response.data.rows[0].elements[0].status === 'OK') {
          update.estimatedDuration = Math.round(response.data.rows[0].elements[0].duration_in_traffic.value / 60);
        }
        break;
      case 'En route to delivery': update.timeEnRouteToDelivery = new Date(); break;
      case 'Onsite at delivery': update.timeArrivedAtDelivery = new Date(); break;
      case 'Completed': update.timeCompleted = new Date(); break;
      case 'Scheduled': break;
    }
    const updatedJob = await Job.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
    if (!updatedJob) return res.status(404).json({ message: 'Job not found' });
    res.json(updatedJob);
  } catch (error) {
    console.error("Error updating status:", error);
    res.status(500).json({ message: 'Error updating job status', error });
  }
});

app.put('/api/jobs/:id/notes', async (req, res) => {
  try {
    const { notes } = req.body;
    const updatedJob = await Job.findByIdAndUpdate(req.params.id, { notes: notes }, { new: true }).lean();
    if (!updatedJob) return res.status(404).json({ message: 'Job not found' });
    res.json(updatedJob);
  } catch (error) { res.status(500).json({ message: 'Error updating job notes', error }); }
});

app.put('/api/jobs/:id/timestamp', async (req, res) => {
  try {
    const { field, newTime } = req.body;
    const editableTimestampFields = ['collectionTime', 'timeEnRouteToCollection', 'timeArrivedAtCollection', 'timeLoaded', 'timeEnRouteToDelivery', 'timeArrivedAtDelivery', 'timeCompleted'];
    if (!editableTimestampFields.includes(field)) { return res.status(400).json({ message: 'Invalid field specified for editing.' }); }
    const updatedJob = await Job.findByIdAndUpdate(req.params.id, { [field]: new Date(newTime) }, { new: true }).lean();
    if (!updatedJob) return res.status(404).json({ message: 'Job not found' });
    res.json(updatedJob);
  } catch (error) { res.status(500).json({ message: 'Error updating timestamp', error }); }
});

app.get('/api/jobs/:id/live-eta', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ message: 'Job not found.' });
    const request = {
      params: {
        origins: [job.collectionAddress], destinations: [job.deliveryAddress],
        departure_time: 'now', key: process.env.Maps_API_KEY,
      },
    };
    const response = await mapsClient.distancematrix(request);
    if (response.data.rows[0].elements[0].status !== 'OK') {
        return res.status(400).json({ message: 'Could not calculate route. Check if addresses are valid.' });
    }
    const durationMinutes = Math.round(response.data.rows[0].elements[0].duration_in_traffic.value / 60);
    job.estimatedDuration = durationMinutes;
    const savedJob = await job.save();
    const jobToReturn = await Job.findById(savedJob._id).lean();
    res.json(jobToReturn);
  } catch (error) {
    console.error("Google Maps API Error:", error);
    res.status(500).json({ message: 'Failed to get live ETA from Google Maps.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});