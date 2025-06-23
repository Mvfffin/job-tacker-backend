const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  referenceNumber: { type: String, required: true, unique: true, trim: true },
  customerName: { type: String, required: true, trim: true },
  driverName: { type: String, required: true, trim: true },
  collectionAddress: { type: String, required: true },
  deliveryAddress: { type: String, required: true },
  collectionTime: { type: Date, required: true },
  estimatedDuration: { type: Number },
  status: {
    type: String,
    required: true,
    enum: ['Scheduled', 'En route to collection', 'Onsite at collection', 'Loaded', 'En route to delivery', 'Onsite at delivery', 'Completed', 'Cancelled'],
    default: 'Scheduled',
  },
  notes: { type: String, default: '' },
  timeEnRouteToCollection: { type: Date },
  timeArrivedAtCollection: { type: Date },
  timeLoaded: { type: Date },
  timeEnRouteToDelivery: { type: Date },
  timeArrivedAtDelivery: { type: Date },
  timeCompleted: { type: Date },
}, {
  timestamps: true 
});

const Job = mongoose.model('Job', jobSchema);
module.exports = Job;