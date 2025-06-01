// 📁 File: bpmFetcher.js (Node backend route)
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const router = express.Router();

function formatForBPMURL(artist, title) {
  return `${artist} ${title}`.toLowerCase().replace(/[^
