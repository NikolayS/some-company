import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../server.js';

const mails=[];
const app=createApp({databasePath:':memory:',env:{NODE_ENV:'test',APP_URL:'http://127.0.0.1:3198',PORT:'3198',RESEND_API_KEY:'test-transport-only',EMAIL_FROM:'test@example.com',DEV_EMAIL_CONSOLE:'0'},sendEmail:async message=>mails.push(message)});
await new Promise(resolve=>app.server.listen(3198,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true,args:['--no-sandbox','--disable-extensions']});
 const errors=[];
 async function member(email,name) {
  const context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:3198/#signin');await page.getByLabel('Your email address').fill(email);await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Email me a sign-in link'}).click();await page.getByRole('heading',{name:'Check your inbox.'}).waitFor();
  await page.goto(mails.find(m=>m.email===email).link);await page.getByRole('button',{name:'Finish signing in'}).click();await page.getByLabel('First name(s) or display name').fill(name);await page.getByLabel('Interests',{exact:true}).fill('Art, gardens, local food');await page.getByLabel('Languages we can chat in').fill('English, Portuguese');await page.getByLabel('A short introduction').fill('I enjoy relaxed walks, long lunches and meeting interesting people.');await page.getByRole('button',{name:'Save my profile'}).click();await page.getByRole('heading',{name:'My plans.'}).waitFor();return page;
 }
 const owner=await member('owner@example.com','Morgan');
 await owner.getByRole('link',{name:'Share a plan',exact:true}).click();await owner.getByLabel('Give your plan a title').fill('Sunday lunch in Porto');await owner.getByLabel('City or region, country').fill('Porto, Portugal');await owner.getByLabel('What do you have in mind?').fill('A relaxed lunch at a local cafe near the river. Everyone pays for their own meal.');await owner.getByRole('button',{name:'Publish my plan'}).click();await owner.getByRole('heading',{name:'Sunday lunch in Porto',exact:true}).waitFor();
 const guest=await member('guest@example.com','Jamie');await guest.getByRole('link',{name:'Find company',exact:true}).click();await guest.getByRole('link',{name:'Sunday lunch in Porto'}).click();await guest.getByLabel('Your introduction').fill('Hello Morgan, I will be in Porto and would enjoy joining you for lunch.');await guest.getByRole('button',{name:'Send a request',exact:true}).click();await guest.getByLabel('Your message').waitFor();
 await owner.getByRole('link',{name:'Conversations',exact:true}).click();await owner.getByRole('link',{name:'Open conversation'}).click();await owner.getByRole('button',{name:'Accept request'}).click();await owner.getByText('You’ve agreed to share this plan.').waitFor();await owner.getByLabel('Your message').fill('See you outside the cafe at one. Looking forward to it!');await owner.getByRole('button',{name:'Send message'}).click();await owner.getByText('See you outside the cafe at one. Looking forward to it!',{exact:true}).waitFor();
 await guest.getByRole('button',{name:'Refresh',exact:true}).click();await guest.getByText('See you outside the cafe at one. Looking forward to it!',{exact:true}).waitFor();await guest.getByText('accepted',{exact:true}).waitFor();
 const mobile=await browser.newPage({viewport:{width:390,height:844}});await mobile.goto('http://127.0.0.1:3198');await mobile.getByRole('link',{name:'Sunday lunch in Porto'}).waitFor();const metrics=await mobile.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth}));assert.equal(metrics.width,metrics.content,'Mobile page must not overflow horizontally');
 assert.deepEqual(errors,[]);console.log('Browser smoke passed: email-link sign-in → profile → publish → request → accept → private reply; mobile 390px without overflow; no JavaScript errors.');
} finally {if(browser)await browser.close();await new Promise(resolve=>app.server.close(resolve));}
