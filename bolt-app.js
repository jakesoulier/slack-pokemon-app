require('dotenv').config();

const express = require('express');
const { App } = require('@slack/bolt');
const axios = require('axios');
const didYouMean = require('didyoumean2').default;

const backend = express();

// pokemonlist for deck
const PokemonList = [];

// get api key, return 401 if not present
function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.MY_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// fetch all pokemon names at startup for suggestions
let allPokemonNames = [];

(async () => {
  try {
    const response = await axios.get('https://pokeapi.co/api/v2/pokemon?limit=2000');
    allPokemonNames = response.data.results.map(p => p.name);
  } catch (e) {
    console.error('Failed to fetch Pokémon names for suggestions.');
    allPokemonNames = [];
  }
})();

// express
backend.get('/pokemon', apiKeyAuth, express.json(), express.urlencoded({ extended: true }), async (req, res) => {
  const name = req.query.name?.toLowerCase();
  if (!name) {
    return res.status(400).json({ error: 'Missing "name" query parameter' });
  }
  try {
    const response = await axios.get(`https://pokeapi.co/api/v2/pokemon/${name}`);
    const pokemonName = response.data.name;
    const pokemonImage = response.data.sprites?.front_default || null;
    res.json({ name: pokemonName, image: pokemonImage });
  } catch (error) {
    // Suggest closest match if not found
    let suggestion = null;
    if (allPokemonNames.length > 0) {
      suggestion = didYouMean(name, allPokemonNames);
    }
    if (suggestion) {
      // Respond with a suggestion and Slack Block Kit buttons
      return res.status(404).json({
        error: `Pokémon "${name}" not found.`,
        suggestion,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Pokémon "${name}" not found. Did you mean *${suggestion}*?`
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Yes' },
                action_id: 'suggested_pokemon_yes',
                value: suggestion
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'No' },
                action_id: 'suggested_pokemon_no',
                value: name
              }
            ]
          }
        ]
      });
    } else {
      res.status(404).json({ error: `Pokémon "${name}" not found` });
    }
  }
});
// returns current deck
backend.get('/pokemon/deck', apiKeyAuth, (req, res) => {
  res.json({ list: PokemonList });
});

// Add a POST endpoint to add a Pokémon name to the local list
backend.post('/pokemon', apiKeyAuth, express.json(), (req, res) => {
  const name = req.body.name?.toLowerCase();
  if (!name) {
    return res.status(400).json({ error: 'Missing "name" in request body' });
  }
  if (PokemonList.includes(name)) {
    return res.status(400).json({ error: `Pokémon '${req.body.name}' is already in your deck.` });
  }
  if (PokemonList.length >= 6) {
    return res.status(400).json({ error: 'Deck is full. Maximum 6 Pokémon allowed.' });
  }
  PokemonList.push(name);
  res.json({ message: `Pokémon '${name}' added.`, list: PokemonList });
});

// 2. Set up your Bolt app
const boltApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// 3. Bolt handler proxies to Express backend
boltApp.command('/jerry', async ({ command, ack, respond, body, client }) => {
  await ack();
  const args = command.text.trim().split(/\s+/);
  if (args[0] === 'search') {
    const pokemonName = args.slice(1).join(' ');
    try {
      const pokeRes = await axios.get(`http://localhost:${process.env.PORT || 3000}/pokemon?name=${encodeURIComponent(pokemonName)}`,
        { headers: { 'x-api-key': process.env.MY_API_KEY } }
      );
      const image = pokeRes.data.image;
      await respond({
        text: `Pokémon found: ${pokeRes.data.name.charAt(0).toUpperCase() + pokeRes.data.name.slice(1)}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Pokémon found: *${pokeRes.data.name.charAt(0).toUpperCase() + pokeRes.data.name.slice(1)}*`
            }
          },
          ...(image ? [{
            type: 'image',
            image_url: image,
            alt_text: pokeRes.data.name
          }] : []),
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Add to Deck'
                },
                action_id: 'add_pokemon',
                value: pokeRes.data.name
              }
            ]
          }
        ]
      });
    } catch (error) {
      if (error.response && error.response.status === 404 && error.response.data && error.response.data.blocks) {
        // If suggestion blocks are present, show them
        await respond({ blocks: error.response.data.blocks, text: error.response.data.error });
      } else if (error.response && error.response.status === 404 && error.response.data && error.response.data.error) {
        await respond(error.response.data.error);
      } else {
        await respond('Error fetching Pokémon data.');
      }
    }
  } else if (args[0] === 'deck') {
    try {
      const deckRes = await axios.get(`http://localhost:${process.env.PORT || 3000}/pokemon/deck`,
        { headers: { 'x-api-key': process.env.MY_API_KEY } }
      );
      const deck = deckRes.data.list || PokemonList;
      if (deck.length === 0) {
        await respond('Your deck is empty.');
      } else {
        // Fetch images for each Pokemon in the deck
        const deckWithImages = await Promise.all(deck.map(async (name) => {
          try {
            const pokeRes = await axios.get(`http://localhost:${process.env.PORT || 3000}/pokemon?name=${encodeURIComponent(name)}`,
              { headers: { 'x-api-key': process.env.MY_API_KEY } }
            );
            return { name, image: pokeRes.data.image };
          } catch {
            return { name, image: null };
          }
        }));
        // Build blocks with small icon next to each name
        const blocks = deckWithImages.map(poke => ({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${poke.name.charAt(0).toUpperCase() + poke.name.slice(1)}*`
          },
          ...(poke.image ? { accessory: { type: 'image', image_url: poke.image, alt_text: poke.name } } : {})
        }));
        await respond({
          text: `Your current deck: ${deck.map(n => n.charAt(0).toUpperCase() + n.slice(1)).join(', ')}`,
          blocks
        });
      }
    } catch (error) {
      await respond('Error fetching your deck.');
    }
  } else {
    await respond('Command error: use `/jerry search <pokemon name>` to search for a Pokémon or `/jerry deck` to view your current deck.');
  }
});

boltApp.action('add_pokemon', async ({ ack, respond, action }) => {
  await ack();
  try {
    const name = action.value.toLowerCase();
    // Use POST /pokemon endpoint with API key header
    await axios.post(`http://localhost:${process.env.PORT || 3000}/pokemon`, { name }, {
      headers: { 'x-api-key': process.env.MY_API_KEY }
    });
    await respond({
      text: `Pokémon '${name.charAt(0).toUpperCase() + name.slice(1)}' added to your deck!\nCurrent deck: ${PokemonList.map(n => n.charAt(0).toUpperCase() + n.slice(1)).join(', ')}`
    });
  } catch (error) {
    let msg = 'Cannot add to deck.';
    if (error.response && error.response.data && error.response.data.error) {
      msg = error.response.data.error;
    }
    await respond({ text: msg });
  }
});

// Handle suggestion button actions
boltApp.action('suggested_pokemon_yes', async ({ ack, body, respond, action }) => {
  await ack();
  const suggestedName = action.value;
  try {
    const pokeRes = await axios.get(`http://localhost:${process.env.PORT || 3000}/pokemon?name=${encodeURIComponent(suggestedName)}`,
      { headers: { 'x-api-key': process.env.MY_API_KEY } }
    );
    const image = pokeRes.data.image;
    await respond({
      text: `Pokémon found: ${pokeRes.data.name.charAt(0).toUpperCase() + pokeRes.data.name.slice(1)}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Pokémon found: *${pokeRes.data.name.charAt(0).toUpperCase() + pokeRes.data.name.slice(1)}*`
          }
        },
        ...(image ? [{
          type: 'image',
          image_url: image,
          alt_text: pokeRes.data.name
        }] : []),
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Add to Deck'
              },
              action_id: 'add_pokemon',
              value: pokeRes.data.name
            }
          ]
        }
      ]
    });
  } catch (error) {
    await respond('Error fetching suggested Pokémon.');
  }
});

boltApp.action('suggested_pokemon_no', async ({ ack, respond }) => {
  await ack();
  await respond({ text: 'No Pokémon selected.' });
});

//  Mount Bolt's requestListener for Slack events/commands
backend.post('/slack/events', async (req, res, next) => {
  await boltApp.receiver.requestListener(req, res, next);
});

// backend.post('/slack/interactions', async (req, res, next) => {
//   await boltApp.receiver.requestListener(req, res, next);
// });


// 5. Start your Express server
const PORT = process.env.PORT || 3000;
backend.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
});



