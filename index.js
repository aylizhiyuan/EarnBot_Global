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
      throw new Error('task not found')
    }
    const task = checkTaskResult.rows[0]
    // 3. check user task
    if (task.unique_task) {
      const checkUserTaskQuery = `SELECT * FROM twitter_users_task WHERE user_id=$1 AND task_id=$2`
      const checkUserTaskResult = await client.query(checkUserTaskQuery, [userId, task.id])
      if (checkUserTaskResult.rows.length > 0) {
        throw new Error('task already done')
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

const escapeTelegramMarkdown = (text) => {
  return text
    .replace(/\_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\~/g, '\\~')
    .replace(/\`/g, '\\`')
    .replace(/\>/g, '\\>')
    .replace(/\#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/\-/g, '\\-')
    .replace(/\=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/\!/g, '\\!')
    .replace(/(?<!\*)\*(?!\*)/g, '')
    .replace(/\*\*(.*?)\*\*/g, (match, p1) => {
      if (p1.includes('\\**')) {
        return `**${p1.replace(/\\(\*\*)/g, '$1')}**`
      }
      return match
    })
}

const jobKol = new CronJob(
  '0 5 */2 * * *',
  async () => {
    console.log(`=======================cron start${moment()}================`)
    const client = await pool.connect()
    const currentDate = moment()
    const twoHourAgo = moment().subtract(2, 'hours').subtract(5, 'minutes')
    const query = `SELECT * FROM public.twitter_news WHERE create_date=$1`
    const pgResult = await client.query(query, [currentDate])
    const { rows } = pgResult
    const twList = rows
      .filter((item) => item.text && item.text.length > 0)
      .map((item) => item.text)
      .flat()
      .filter((item) => moment(item.time).isBefore(currentDate) && moment(item.time).isAfter(twoHourAgo))
    console.log(`======news list=====`, twList)
    if (twList.length >= 1) {
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' })
      const prompt = `Please generate a English news report on the cryptocurrency market based on the following information, and label it as a cryptocurrency market news report. The report should meet the following requirements:Objective Statement: Only state facts, avoiding subjective analysis or judgment.Information Filtering: Only extract information related to the cryptocurrency market, including project details, coin information, airdrop information, and market predictions. Exclude information unrelated to the cryptocurrency market, exclude sharing and link addresses, and do not include personal life and emotional content of bloggers (directly ignore).Classification and Organization: Classify and organize the blog content. Articles on similar topics should integrate relevant information and be expressed in formal written language, avoiding colloquial expressions.Influencing Factors: Extract and highlight key information that may affect the cryptocurrency market trends, such as policy changes, major events, or market-breaking news.Markdown Format: Use standard markdown format, do not use special characters, ensure appropriate line breaks for content completeness, emphasize key content in bold, remove all link addresses,ensure the information is concise and does not exceed 4096 characters. Information as follows:${JSON.stringify(
        twList
      )}`
      const result = await model.generateContent(prompt)
      const response = await result.response
      const text = response.text()
      bot.sendMessage(-1002151619852, escapeTelegramMarkdown(text), { parse_mode: 'MarkdownV2' })
    }
    client.release()
  }, // onTick
  null, // onComplete
  true, // start
  'system', // timeZone
  null, // context
  false // run on init
)

const jobNews = new CronJob(
  '0 10 */3 * * *',
  async () => {
    console.log(`=======================cron start ${moment()}================`)
    const client = await pool.connect()
    const query = `SELECT * FROM public.twitter_kol WHERE create_date=$1`
    const currentDate = moment()
    const twoHourAgo = moment().subtract(3, 'hours').subtract(5, 'minutes')
    const pgResult = await client.query(query, [currentDate])
    const { rows } = pgResult
    const twList = rows
      .filter((item) => item.text && item.text.length > 0)
      .map((item) => item.text)
      .flat()
      .filter((item) => moment(item.time).isBefore(currentDate) && moment(item.time).isAfter(twoHourAgo))
    console.log(`======KOL list=====`, twList)
    if (twList.length >= 1) {
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' })
      const prompt = `Please generate a English KOL real-time dynamics report based on the following information, and label it as a KOL Real-Time Dynamics Report. The report should meet the following requirements:Objective Statement: Only state facts, avoiding subjective analysis or judgment.Information Filtering: Only extract information related to the cryptocurrency market, including project details, coin information, airdrop information, and market predictions. Exclude information unrelated to the cryptocurrency market, exclude KOL-shared link addresses, and do not include KOL personal life and emotional content (directly ignore).Classification and Organization: Classify and organize the blog content. Articles on similar topics should integrate relevant information and be expressed in formal written language, avoiding colloquial expressions.Influencing Factors: Extract and highlight key information that may affect cryptocurrency market trends, such as policy changes, major events, or market-breaking news.Markdown Format: Use standard markdown format, do not use special characters, ensure appropriate line breaks for content completeness, emphasize key content in bold, remove all link addresses, ensure the information is concise and does not exceed 4096 characters. Information as follows:${JSON.stringify(
        twList
      )}`
      const result = await model.generateContent(prompt)
      const response = await result.response
      const text = response.text()
      bot.sendMessage(-1002151619852, escapeTelegramMarkdown(text), { parse_mode: 'MarkdownV2' })
    }
    client.release()
  }, // onTick
  null, // onComplete
  true, // start
  'system', // timeZone
  null, // context
  false // run on init
)

const jobOfficial = new CronJob(
  '0 15 */6 * * *',
  async () => {
    console.log(`=======================cron start ${moment()}================`)
    const client = await pool.connect()
    const query = `SELECT * FROM public.twitter_official WHERE create_date=$1`
    const currentDate = moment()
    const twoHourAgo = moment().subtract(6, 'hours').subtract(5, 'minutes')
    const pgResult = await client.query(query, [currentDate])
    const { rows } = pgResult
    const twList = rows
      .filter((item) => item.text && item.text.length > 0)
      .map((item) => item.text)
      .flat()
      .filter((item) => moment(item.time).isBefore(currentDate) && moment(item.time).isAfter(twoHourAgo))
    console.log(`======coin list======`, twList)
    if (twList.length >= 1) {
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' })
      const prompt = `Please generate a English on-chain official news report based on the following information, and label it as an On-Chain Official News Report. The report should meet the following requirements:Objective Statement: Only state facts, avoiding subjective analysis or judgment.Information Filtering: Only extract information related to the cryptocurrency market, including project details, coin information, airdrop information, and market predictions. Exclude information unrelated to the cryptocurrency market, exclude shared link addresses, and do not include personal life and emotional content of the bloggers (directly ignore).Classification and Organization: Classify and organize the blog content. Articles on similar topics should integrate relevant information and be expressed in formal written language, avoiding colloquial expressions.Influencing Factors: Extract and highlight key information that may affect cryptocurrency market trends, such as policy changes, major events, or market-breaking news.Markdown Format: Use standard markdown format, do not use special characters, ensure appropriate line breaks for content completeness, emphasize key content in bold, remove all link addresses,and ensure the information is concise and does not exceed 4096 characters. Information as follows:${JSON.stringify(twList)}`
      const result = await model.generateContent(prompt)
      const response = await result.response
      const text = response.text()
      bot.sendMessage(-1002151619852, escapeTelegramMarkdown(text), { parse_mode: 'MarkdownV2' })
    }
    client.release()
  }, // onTick
  null, // onComplete
  true, // start
  'system', // timeZone
  null, // context
  false // run on init
)
