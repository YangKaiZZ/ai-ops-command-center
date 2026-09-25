const express = require('express');
const router = express.Router();
const { getRating, putRating } = require('../controllers/rateController');

// No sign-in: each link carries a signed token for one decision.
router.get('/:token', getRating);
router.put('/:token', putRating);

module.exports = router;
