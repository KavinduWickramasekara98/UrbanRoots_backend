const express = require('express');
const admin = require('firebase-admin');
const cron = require('node-cron');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Initialize Firebase Admin (using service account from env var)
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
} catch (error) {
  console.error("Error parsing FIREBASE_SERVICE_ACCOUNT:", error.message);
  throw new Error("Invalid Firebase service account configuration");
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
const messaging = admin.messaging();

// HTTP Endpoint: /onCropAdded (call from Android after adding crop)
app.post('/onCropAdded', async (req, res) => {
  try {
    const { cropId: docId, data } = req.body;  // docId is the Firestore doc ID of user_crops
    const plantedTimestamp = data.plantedTimestamp;
    const cropId = data.cropId;
    const userId = data.userId;  // FarmerId

    if (!plantedTimestamp || !cropId) {
      return res.status(400).json({ error: 'Missing plantedTimestamp or cropId' });
    }

    // Fetch wateringInterval from crops
    const cropDoc = await db.collection('crops').doc(cropId).get();
    if (!cropDoc.exists) {
      return res.status(404).json({ error: 'Crop not found' });
    }
    const wateringInterval = cropDoc.data().wateringInterval;
    const intervalMs = parseInterval(wateringInterval);
    if (!intervalMs) {
      return res.status(400).json({ error: 'Invalid interval' });
    }

    const nextWatering = admin.firestore.Timestamp.fromMillis(plantedTimestamp.toMillis() + intervalMs);

    // Update user_crops doc
    await db.collection('user_crops').doc(docId).update({ nextWateringTimestamp: nextWatering });
    res.json({ success: true, nextWateringTimestamp: nextWatering });
  } catch (error) {
    console.error('Error in onCropAdded:', error);
    res.status(500).json({ error: error.message });
  }
});

// Scheduled Job: Check reminders every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  console.log('Checking watering reminders...');
  const now = admin.firestore.Timestamp.now();

  const dueCrops = await db.collection('user_crops')
    .where('nextWateringTimestamp', '<=', now)
    .get();

  if (dueCrops.empty) {
    console.log('No due crops');
    return;
  }

  for (const doc of dueCrops.docs) {
    const data = doc.data();
    const userId = data.userId;
    const cropType = data.cropType || 'your plant';

    // Fetch farmer FCM token
    const farmerDoc = await db.collection('farmers').doc(userId).get();
    if (!farmerDoc.exists) continue;
    const fcmToken = farmerDoc.data().fcmToken;
    if (!fcmToken) continue;

    // Send notification
    const message = {
      notification: {
        title: 'Time to Water!',
        body: `Don't forget to water your ${cropType}. It's been ${data.wateringInterval}!`,
      },
      token: fcmToken,
    };

    try {
      await messaging.send(message);
      console.log(`Notification sent for farmer ${userId}`);
    } catch (error) {
      console.error('Error sending notification:', error);
    }

    // Update next timestamp
    const intervalMs = parseInterval(data.wateringInterval);
    const nextNext = admin.firestore.Timestamp.fromMillis(now.toMillis() + intervalMs);
    await doc.ref.update({ nextWateringTimestamp: nextNext });
  }
});

// Helper: Parse interval (e.g., "2 days" -> ms)
function parseInterval(intervalStr) {
  const match = intervalStr.match(/^(\d+)\s*(days?|weeks?|hours?|months?)$/i);
  if (!match) return null;
  const num = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  switch (unit[0]) {
    case 'd': return num * 24 * 60 * 60 * 1000;
    case 'w': return num * 7 * 24 * 60 * 60 * 1000;
    case 'h': return num * 60 * 60 * 1000;
    case 'm': return num * 30 * 24 * 60 * 60 * 1000;  // Approx
    default: return null;
  }
}

// Health check endpoint (Heroku pings this to keep awake, but free sleeps anyway)
app.get('/', (req, res) => res.send('UrbanRoots Notifications Backend'));

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});