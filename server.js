// server.js - Node.js Express Server for Spotify OAuth
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files

// Spotify API credentials (store in .env file)
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;

// Store user sessions (in production, use a proper database)
const userSessions = new Map();

// Generate random string for state parameter
function generateRandomString(length) {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// Route: Initiate Spotify OAuth
app.get('/auth/spotify', (req, res) => {
  const state = generateRandomString(16);
  // Updated scopes to include user-library-read for accessing audio features
  const scope = 'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-read-private user-library-read user-read-recently-played';

  const authURL = 'https://accounts.spotify.com/authorize?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: scope,
      redirect_uri: REDIRECT_URI,
      state: state
    });

  // Store state for validation
  userSessions.set(state, { timestamp: Date.now() });

  console.log('Initiating OAuth with scopes:', scope);
  res.redirect(authURL);
});

// Route: Handle Spotify OAuth callback
app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  const state = req.query.state || null;

  if (!state || !userSessions.has(state)) {
    return res.redirect('/error?message=invalid_state');
  }

  // Clean up state
  userSessions.delete(state);

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({
        code: code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      }), {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Get user profile
    const userResponse = await axios.get('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': `Bearer ${access_token}` }
    });

    const userId = userResponse.data.id;

    // Store tokens (in production, encrypt and use proper database)
    userSessions.set(userId, {
      access_token,
      refresh_token,
      expires_at: Date.now() + (expires_in * 1000),
      user_data: userResponse.data
    });

    // Redirect to frontend with success
    res.redirect(`/?auth=success&user_id=${userId}`);

  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.redirect('/error?message=auth_failed');
  }
});

// Route: Get user's access token (for frontend)
app.get('/api/auth/token/:userId', (req, res) => {
  const userId = req.params.userId;
  const session = userSessions.get(userId);

  if (!session) {
    return res.status(401).json({ error: 'No valid session' });
  }

  // Check if token is expired
  if (Date.now() >= session.expires_at) {
    return refreshAccessToken(userId, res);
  }

  res.json({
    access_token: session.access_token,
    user: session.user_data
  });
});

// Function: Refresh access token
async function refreshAccessToken(userId, res) {
  const session = userSessions.get(userId);

  if (!session?.refresh_token) {
    return res.status(401).json({ error: 'No refresh token available' });
  }

  try {
    const response = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refresh_token
      }), {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

    const { access_token, expires_in, refresh_token } = response.data;

    // Update session
    session.access_token = access_token;
    session.expires_at = Date.now() + (expires_in * 1000);
    if (refresh_token) session.refresh_token = refresh_token;

    userSessions.set(userId, session);

    res.json({
      access_token: access_token,
      user: session.user_data
    });

  } catch (error) {
    console.error('Token refresh error:', error.response?.data || error.message);
    res.status(401).json({ error: 'Token refresh failed' });
  }
}

// Route: Create playlist with mood-sorted songs
app.post('/api/playlist/create', async (req, res) => {
  const { userId, playlistName, songUris, description } = req.body;
  const session = userSessions.get(userId);

  if (!session) {
    return res.status(401).json({ error: 'No valid session' });
  }

  try {
    // Create new playlist
    const createResponse = await axios.post(
      `https://api.spotify.com/v1/users/${userId}/playlists`,
      {
        name: playlistName,
        description: description || 'Mood-sorted playlist created by Spotify Mood Sorter',
        public: false
      },
      {
        headers: { 'Authorization': `Bearer ${session.access_token}` }
      }
    );

    const playlistId = createResponse.data.id;

    // Add songs to playlist (Spotify API limit: 100 songs per request)
    const chunks = [];
    for (let i = 0; i < songUris.length; i += 100) {
      chunks.push(songUris.slice(i, i + 100));
    }

    for (const chunk of chunks) {
      await axios.post(
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
        { uris: chunk },
        {
          headers: { 'Authorization': `Bearer ${session.access_token}` }
        }
      );
    }

    res.json({
      success: true,
      playlist: createResponse.data,
      songsAdded: songUris.length
    });

  } catch (error) {
    console.error('Playlist creation error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to create playlist',
      details: error.response?.data || error.message
    });
  }
});

// Route: Get user's playlists
app.get('/api/playlists/:userId', async (req, res) => {
  const userId = req.params.userId;
  const session = userSessions.get(userId);

  if (!session) {
    return res.status(401).json({ error: 'No valid session' });
  }

  try {
    const response = await axios.get('https://api.spotify.com/v1/me/playlists?limit=50', {
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });

    res.json(response.data);

  } catch (error) {
    console.error('Playlists fetch error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Route: Get audio features for multiple tracks
app.get('/api/audio-features', async (req, res) => {
  const userId = req.query.user_id;
  const trackIds = req.query.ids; // Comma-separated track IDs

  const session = userSessions.get(userId);

  if (!session) {
    return res.status(401).json({ error: 'No valid session' });
  }

  // Check if token is expired and refresh if needed
  if (Date.now() >= session.expires_at) {
    console.log('Token expired, attempting refresh...');
    try {
      await refreshTokenForSession(userId);
    } catch (error) {
      console.error('Token refresh failed:', error);
      return res.status(401).json({ error: 'Token refresh failed', details: error.message });
    }
  }

  try {
    const url = `https://api.spotify.com/v1/audio-features?ids=${trackIds}`;
    console.log(`Fetching audio features for tracks: ${trackIds}`);

    const response = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });

    res.json(response.data);

  } catch (error) {
    console.error('Audio features fetch error:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      url: error.config?.url
    });

    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch audio features',
      details: error.response?.data || error.message,
      status: error.response?.status
    });
  }
});

// Route: Proxy Spotify API requests (for CORS)
app.get('/api/spotify/*', async (req, res) => {
  const userId = req.query.user_id;
  const session = userSessions.get(userId);

  if (!session) {
    return res.status(401).json({ error: 'No valid session' });
  }

  // Check if token is expired and refresh if needed
  if (Date.now() >= session.expires_at) {
    console.log('Token expired, attempting refresh...');
    try {
      await refreshTokenForSession(userId);
    } catch (error) {
      console.error('Token refresh failed:', error);
      return res.status(401).json({ error: 'Token refresh failed', details: error.message });
    }
  }

  try {
    const spotifyPath = req.params[0];
    const query = { ...req.query };
    delete query.user_id;

    const queryString = new URLSearchParams(query).toString();
    const url = `https://api.spotify.com/v1/${spotifyPath}${queryString ? '?' + queryString : ''}`;

    console.log(`Making Spotify API request to: ${url}`);
    console.log(`Token starts with: ${session.access_token.substring(0, 10)}...`);

    const response = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });

    res.json(response.data);

  } catch (error) {
    console.error('Spotify API proxy error:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      url: error.config?.url
    });

    res.status(error.response?.status || 500).json({
      error: 'Spotify API request failed',
      details: error.response?.data || error.message,
      status: error.response?.status
    });
  }
});

// Helper function to refresh token for a session
async function refreshTokenForSession(userId) {
  const session = userSessions.get(userId);

  if (!session?.refresh_token) {
    throw new Error('No refresh token available');
  }

  const response = await axios.post('https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refresh_token
    }), {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

  const { access_token, expires_in, refresh_token } = response.data;

  // Update session
  session.access_token = access_token;
  session.expires_at = Date.now() + (expires_in * 1000);
  if (refresh_token) session.refresh_token = refresh_token;

  userSessions.set(userId, session);
  return session;
}

// Error page
app.get('/error', (req, res) => {
  const message = req.query.message || 'unknown_error';
  res.send(`
    <html>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1>Authentication Error</h1>
        <p>Error: ${message}</p>
        <a href="/">Try Again</a>
      </body>
    </html>
  `);
});

// Serve the main app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🎵 Spotify Mood Sorter Server running on http://localhost:${PORT}`);
  console.log(`📋 Make sure to set your Spotify app redirect URI to: http://localhost:${PORT}/callback`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Server shutting down...');
  process.exit(0);
});
