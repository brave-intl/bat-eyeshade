const { votesId } = require('../lib/queries.js')
const { voteType } = require('../lib/vote.js')
const moment = require('moment')

const voteTopic = process.env.ENV + '.payment.vote'

module.exports = (runtime) => {
  runtime.kafka.on({ topic: voteTopic, decode: voteType }, async (messages, client) => {
    const date = moment().format('YYYY-MM-DD')
    for (let i = 0; i < messages.length; i += 1) {
      const vote = messages[i]
      // const buf = Buffer.from(message.value, 'binary')
      // let vote
      // try {
      //   vote = voteType.fromBuffer(buf)
      // } catch (e) {
      //   // If the event is not well formed, capture the error and continue
      //   runtime.captureException(e, { extra: { topic: voteTopic, message: message } })
      //   continue
      // }

      const surveyorId = date + '_' + vote.fundingSource
      const cohort = 'control'
      const tally = vote.voteTally
      const voteValue = vote.baseVoteValue
      const publisher = vote.channel

      const surveyorUpdate = `
          insert into surveyor_groups (id, price, virtual) values ($1, $2, true)
          on conflict (id) do nothing;
          `
      await runtime.postgres.query(surveyorUpdate, [
        surveyorId,
        voteValue
      ], client)

      const voteUpdate = `
          insert into votes (id, cohort, tally, excluded, channel, surveyor_id) values ($1, $2, $3, $4, $5, $6)
          on conflict (id) do update set updated_at = current_timestamp, tally = votes.tally + $3;
          `
      await runtime.postgres.query(voteUpdate, [
        votesId(publisher, cohort, surveyorId),
        cohort,
        tally,
        runtime.config.testingCohorts.includes(cohort),
        publisher,
        surveyorId
      ], client)
    }
  })
}
