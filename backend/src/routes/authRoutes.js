const express = require('express');
const router = express.Router();
const { register, config, login, forgotPassword, resetPassword } = require('../controllers/authController');

router.get('/config', config);
router.post('/register', register);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;
