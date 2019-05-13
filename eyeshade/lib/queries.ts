import uuidv5 from 'uuid/v5'

export default {
  settlements,
  earnings,
  votesId
}

function votesId (channel, cohort, surveyorId) {
  return uuidv5(channel + cohort + surveyorId, 'f0ca8ff9-8399-493a-b2c2-6d4a49e5223a')
}

function earnings (options = <any>{}) {
  const {
    asc
  } = options
  const order = asc ? 'ASC' : 'DESC'
  return `
 select
   channel,
   coalesce(sum(amount), 0.0) as earnings,
   account_id
 from account_transactions
 where account_type = 'owner' and transaction_type = $1
 group by (account_id, channel)
 order by earnings ${order}
 limit $2;`
}

function settlements (options = <any>{}) {
  const {
    asc
  } = options
  const order = asc ? 'ASC' : 'DESC'
  return `
 select
   channel,
   coalesce(sum(-amount), 0.0) as paid,
   account_id
 from account_transactions
 where account_type = 'owner' and transaction_type = $1
 group by (account_id, channel)
 order by paid ${order}
 limit $2;`
}
