const TelegramBot = require('node-telegram-bot-api')
const { CronJob } = require('cron')
const express = require('express')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const pg = require('pg')
const moment = require('moment')
const { Pool } = pg
require('dotenv').config()
const TOKEN = process.env.TG_TOKEN
const PORT = process.env.PORT || 3000
const URL = process.env.HTTPS_DOMAIN
const bot = new TelegramBot(TOKEN)
bot.setWebHook(`${URL}/bot${TOKEN}`)
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_KEY)
const pool = new Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USERNAME,
  password: process.env.PG_PASSWORD,
})
const app = express()
app.use(express.json())
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body)
  res.sendStatus(200)
})

app.get('/follow', async (req, res) => {
  const { userId, userName } = req.query
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    // 1. has users
    const checkUserQuery = `SELECT * FROM twitter_users WHERE user_id=$1`
    const checkUserResult = await client.query(checkUserQuery, [userId])
    if (checkUserResult.rows.length === 0) {
      // insert user info
      const insertUserQuery = `INSERT INTO twitter_users (user_id,user_name) VALUES ($1,$2)`
      await client.query(insertUserQuery, [userId, userName])
    }
    // 2. check task
    const checkTaskQuery = `SELECT * FROM twitter_task WHERE name=$1`
    const checkTaskResult = await client.query(checkTaskQuery, ['follow_twitter'])
    if (checkTaskResult.rows.length === 0) {
      throw new Error('任务不存在')
    }
    const task = checkTaskResult.rows[0]
    // 3. check user task
    if (task.unique_task) {
      const checkUserTaskQuery = `SELECT * FROM twitter_users_task WHERE user_id=$1 AND task_id=$2`
      const checkUserTaskResult = await client.query(checkUserTaskQuery, [userId, task.id])
      if (checkUserTaskResult.rows.length > 0) {
        throw new Error('任务已完成,无法重复完成')
      }
    }
    // 4. update user points
    const updateUsersPointsQuery = `UPDATE twitter_users SET points=points+$1 WHERE user_id=$2`
    await client.query(updateUsersPointsQuery, [task.points, userId])
    // 5. insert user task
    const insertUserTaskQuery = `INSERT INTO twitter_users_task (user_id, task_id)
      VALUES ($1, $2)`
    await client.query(insertUserTaskQuery, [userId, task.id])
    await client.query('COMMIT')
    await client.release()
  } catch (e) {
    // rollback
    await client.query('ROLLBACK')
    await client.release()
    console.error('commit error:', e)
  }
  res.redirect('https://x.com/earnbot2024')
})

app.listen(PORT, () => {
  console.log(`express server is listening on ${PORT}`)
})

const news_options = {
  reply_markup: {
    inline_keyboard: [[{ text: '⭐ Helpful', callback_data: 'helpful' }]],
  },
}
// start
bot.onText(/\/start/, async (msg) => {
  bot.sendMessage(msg.chat.id, '🎉Welcome, I am Earnbot global version 🤖, I am happy to provide services to you', {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '⭐ Follow X',
            url: `${URL}/follow?userId=${msg.chat.id}&userName=${msg.chat.username}`,
          },
        ],
      ],
    },
  })
})

bot.on('callback_query', async function onCallbackQuery(query) {
  const { id, from, message, data } = query
  // start click
  if (data === 'helpful') {
    const client = await pool.connect()
    bot.answerCallbackQuery(id, { text: '💗 Thank you for your feedback. 💗' })
    // update click count
    const dataValue = `('${id}','${message.message_id}',1,'${message.chat.id}','${new Date(message.date * 1000).toISOString()}')`
    const excute_query = `INSERT INTO twitter_task_useful (id,message_id,useful_count,chat_id,create_date) VALUES ${dataValue} ON CONFLICT (message_id,chat_id,create_date) DO UPDATE SET useful_count=twitter_task_useful.useful_count+1 RETURNING *`
    const res = await client.query(excute_query)
    const currentCount = res.rows[0].useful_count || 1
    client.release()
    bot.editMessageReplyMarkup(
      {
        inline_keyboard: [[{ text: `⭐ Helpful +${currentCount}`, callback_data: 'helpful' }]],
      },
      {
        chat_id: message.chat.id,
        message_id: message.message_id,
      }
    )
  }
})

// pollingError
bot.on('polling_error', async (error) => {
  console.log('polling_error', error)
  await pool.end()
})

// webhook_error
bot.on('webhook_error', async (error) => {
  console.log('webhook_error', error)
  await pool.end()
})

// ERROR
bot.on('error', async (error) => {
  console.log('bot_error', error)
  await pool.end()
})

// uncaughtException
process.on('uncaughtException', async (err) => {
  console.log('Caught exception: ' + err)
  await pool.end()
})
