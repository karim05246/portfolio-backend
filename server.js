const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());

// Configure Nodemailer transport
let transporter;

async function setupTransporter() {
  if (process.env.EMAIL_USER && process.env.EMAIL_USER !== 'your_email@gmail.com') {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
    console.log("Using provided email credentials.");
  } else {
    console.log("No real email credentials provided. Creating Ethereal test account to check email sending...");
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
  }
}
setupTransporter();

app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Please provide name, email, and message.' });
  }

  const mailOptions = {
    from: email,
    to: process.env.RECEIVER_EMAIL || process.env.EMAIL_USER,
    subject: `New contact from ${name} via Portfolio`,
    text: `You have received a new message from your portfolio website.\n\nName: ${name}\nEmail: ${email}\nMessage:\n${message}`,
    html: `<p>You have received a new message from your portfolio website.</p>
           <p><strong>Name:</strong> ${name}</p>
           <p><strong>Email:</strong> ${email}</p>
           <p><strong>Message:</strong><br/>${message}</p>`
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Message sent: %s', info.messageId);
    
    // Preview URL will only be present if using Ethereal test account
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log('Preview URL (Check your test email here): %s', previewUrl);
    }

    res.status(200).json({ 
      success: true, 
      message: 'Email sent successfully!',
      previewUrl: previewUrl || null 
    });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ success: false, error: 'Failed to send email.' });
  }
});

app.get('/', (req, res) => {
  res.send('Backend server is running');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
