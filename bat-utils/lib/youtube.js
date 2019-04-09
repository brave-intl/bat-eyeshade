'use strict'

const braveHapi = require('./extras-hapi')
const {
  YOUTUBE_API_KEY,
  YOUTUBE_API_BASE_URI
} = require('../../env')

async function getYoutubeChannelId (youtubeUsername) {
  const youtubeApiKey = YOUTUBE_API_KEY
  const youtubeApiBaseUri = YOUTUBE_API_BASE_URI || 'https://www.googleapis.com'

  let response = await braveHapi.wreck.get(`${youtubeApiBaseUri}/youtube/v3/channels?part=id&forUsername=${youtubeUsername}&key=${youtubeApiKey}`)
  response = JSON.parse(response)

  if (response.items.length === 0) {
    return null
  } else {
    return response.items[0].id
  }
}

module.exports = getYoutubeChannelId
