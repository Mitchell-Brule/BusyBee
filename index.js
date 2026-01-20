const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files

// Import your existing availability logic
const { checkAvailability } = require('./availability');

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'BusyBee is running! 🐝', 
    timestamp: new Date().toISOString()
  });
});

// Test availability endpoint
app.post('/api/availability', (req, res) => {
  try {
    const { userId, timeSlot } = req.body;
    const availability = checkAvailability(userId, timeSlot);
    res.json({ availability });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🐝 BusyBee server running on port ${PORT}`);
});
```__
