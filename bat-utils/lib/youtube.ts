'use strict'

import braveHapi from './extras-hapi'

async function getYoutubeChannelId (youtubeUsername) {
  const youtubeApiKey = process.env.YOUTUBE_API_KEY
  const youtubeApiBaseUri = process.env.YOUTUBE_API_BASE_URI || 'https://www.googleapis.com'
  const url = `${youtubeApiBaseUri}/youtube/v3/channels?part=id&forUsername=${youtubeUsername}&key=${youtubeApiKey}`
  let response = await braveHapi.wreck.get(url)
  response = JSON.parse(response)

  if (response.items.length === 0) {
    return null
  } else {
    return response.items[0].id
  }
}

export default getYoutubeChannelId
