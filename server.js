const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

const SMTP_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS) || 15000;
const SEND_MAIL_TIMEOUT_MS = Number(process.env.SEND_MAIL_TIMEOUT_MS) || 20000;

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
].filter(Boolean);

const corsOptions = process.env.FRONTEND_URL
  ? {
      origin: allowedOrigins,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
    }
  : {
      origin: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
    };

app.use(express.json());
app.use(cors(corsOptions));

let transporter = null;
let transporterError = null;
let transporterReady = false;
let emailTransport = 'none';

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function hasRealEmailCredentials() {
  return Boolean(
    process.env.EMAIL_USER &&
      process.env.EMAIL_PASS &&
      process.env.EMAIL_USER !== 'your_email@gmail.com'
  );
}

function getEmailPass() {
  return (process.env.EMAIL_PASS || '').replace(/\s/g, '');
}

function createResendTransporter() {
  const apiKey = process.env.RESEND_API_KEY;
  const defaultFrom =
    process.env.EMAIL_FROM ||
    `"Portfolio Contact" <onboarding@resend.dev>`;

  return {
    name: 'resend-http',
    async verify() {
      return true;
    },
    async sendMail(mailOptions) {
      const to = Array.isArray(mailOptions.to)
        ? mailOptions.to
        : String(mailOptions.to || '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);

      const payload = {
        from: mailOptions.from || defaultFrom,
        to,
        subject: mailOptions.subject,
        html: mailOptions.html,
        text: mailOptions.text,
      };

      if (mailOptions.replyTo) {
        payload.reply_to = mailOptions.replyTo;
      }

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.message || data.error || `Resend API error (${response.status})`);
      }

      return { messageId: data.id || 'resend-sent' };
    },
  };
}

async function setupTransporter() {
  transporterReady = false;
  transporterError = null;
  transporter = null;
  emailTransport = 'none';

  try {
    const onRender = Boolean(process.env.RENDER);
    const resendKey = (process.env.RESEND_API_KEY || '').trim();

    if (resendKey) {
      transporter = createResendTransporter();
      emailTransport = 'resend';
      transporterReady = true;
      console.log('Using Resend HTTP API (Render-compatible).');
      return;
    }

    if (onRender) {
      transporterError = new Error(
        'RESEND_API_KEY is missing on Render. Gmail SMTP is blocked on the free tier.'
      );
      console.error(transporterError.message);
      return;
    }

    if (hasRealEmailCredentials()) {
      transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: {
          user: process.env.EMAIL_USER,
          pass: getEmailPass(),
        },
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
      });
      emailTransport = 'gmail-smtp';
      console.log('Using Gmail SMTP credentials from environment.');
    } else {
      console.log('No email credentials found. Creating Ethereal test account...');
      const testAccount = await withTimeout(
        nodemailer.createTestAccount(),
        SMTP_TIMEOUT_MS,
        'Ethereal account creation'
      );

      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
      });
      emailTransport = 'ethereal';
      console.log('Using Ethereal test SMTP account.');
    }

    try {
      await withTimeout(transporter.verify(), SMTP_TIMEOUT_MS, 'SMTP verify');
      console.log('Email transporter verified.');
    } catch (verifyError) {
      console.warn('SMTP verify skipped/failed:', verifyError.message);
    }

    transporterReady = true;
    console.log('Email transporter is ready.');
  } catch (error) {
    transporter = null;
    transporterReady = false;
    transporterError = error;
    console.error('Failed to initialize email transporter:', error.message);
  }
}

async function startServer() {
  await setupTransporter();

  app.get('/', (_req, res) => {
    res.send('Backend server is running');
  });

  app.get('/api/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      emailReady: transporterReady,
      transport: emailTransport,
      emailError: transporterError ? transporterError.message : null,
    });
  });

  app.post('/api/contact', async (req, res) => {
    try {
      const { name, email, message } = req.body || {};

      if (!name || !email || !message) {
        return res.status(400).json({
          success: false,
          error: 'Please provide name, email, and message.',
        });
      }

      if (!transporterReady || !transporter) {
        return res.status(503).json({
          success: false,
          error: 'Email service is not ready. Please try again shortly.',
        });
      }

      const receiver = process.env.RECEIVER_EMAIL || process.env.EMAIL_USER;
      if (!receiver) {
        return res.status(500).json({
          success: false,
          error: 'Receiver email is not configured on the server.',
        });
      }

      const sender =
        process.env.EMAIL_FROM ||
        (process.env.EMAIL_USER
          ? `"Portfolio Contact" <${process.env.EMAIL_USER}>`
          : '"Portfolio Contact" <onboarding@resend.dev>');

      const mailOptions = {
        from: sender,
        replyTo: email,
        to: receiver,
        subject: `New contact from ${name} via Portfolio`,
        text: `You have received a new message from your portfolio website.\n\nName: ${name}\nEmail: ${email}\nMessage:\n${message}`,
        html: `<p>You have received a new message from your portfolio website.</p>
               <p><strong>Name:</strong> ${name}</p>
               <p><strong>Email:</strong> ${email}</p>
               <p><strong>Message:</strong><br/>${message.replace(/\n/g, '<br/>')}</p>`,
      };

      const info = await withTimeout(
        transporter.sendMail(mailOptions),
        SEND_MAIL_TIMEOUT_MS,
        'Email send'
      );

      console.log('Message sent: %s', info.messageId);

      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        console.log('Preview URL: %s', previewUrl);
      }

      return res.status(200).json({
        success: true,
        message: 'Email sent successfully!',
        previewUrl: previewUrl || null,
      });
    } catch (error) {
      console.error('Error in /api/contact:', error.message || error);

      const hint =
        emailTransport === 'gmail-smtp' && process.env.RENDER
          ? ' Render free tier blocks SMTP. Add RESEND_API_KEY in Render environment variables.'
          : '';

      return res.status(500).json({
        success: false,
        error: 'Failed to send email. Please try again later.',
        ...(process.env.NODE_ENV !== 'production' && {
          details: `${error.message || error}${hint}`,
        }),
      });
    }
  });

  app.use((err, _req, res, _next) => {
    console.error('Unhandled middleware error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  });

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'Route not found.' });
  });

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on port ${port}`);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
