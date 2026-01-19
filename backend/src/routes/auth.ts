import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from '../config/database.js';

const router = Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    // Check if user exists
    const [existingUsers]: any = await db.query(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      [username, email]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({ message: 'Username or email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const [result]: any = await db.query(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
      [username, email, passwordHash]
    );

    const userId = result.insertId;

    // Generate token
    const token = jwt.sign({ userId }, process.env.JWT_SECRET || 'your_jwt_secret', {
      expiresIn: '7d'
    });

    res.status(201).json({
      message: 'User created successfully',
      token,
      userId,
      onboardingComplete: false
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    // Find user
    const [users]: any = await db.query(
      'SELECT id, password_hash FROM users WHERE username = ?',
      [username]
    );

    if (users.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = users[0];

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check onboarding status
    const [config]: any = await db.query(
      'SELECT is_onboarding_complete FROM user_config WHERE user_id = ?',
      [user.id]
    );

    const onboardingComplete = config.length > 0 && config[0].is_onboarding_complete;

    // Generate token
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'your_jwt_secret', {
      expiresIn: '7d'
    });

    res.json({
      message: 'Login successful',
      token,
      userId: user.id,
      onboardingComplete
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
