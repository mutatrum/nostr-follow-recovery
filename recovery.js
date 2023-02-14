require('dotenv').config();

const https = require("https");
const { RelayPool, calculateId, signId } = require('nostr');
const WebSocket = require('ws')
const { bech32 } = require('bech32')
const buffer = require('buffer')

https.get('https://nostr.watch/relays.json', (resp) => {
  let data = '';
  resp.on('data', (chunk) => data += chunk);
  resp.on('end', () => createPool(JSON.parse(data).relays));
}).on('error', (err) => console.log("Error: " + err.message));

let me = process.env.PUBKEY
if (me.startsWith('npub1')) me = npubtopubkey(me)

console.log(`Finding follow lists for ${me}`)

let follows = []
let entries = {}
let content = {}
let opened = []

function createPool(relays) {

  const pool = RelayPool(relays, {reconnect: false})
  
  pool.on('open', relay => {
    opened.push(relay.url)
    // console.log(`Open ${relay.url}`)
    relay.subscribe('sub', {kinds:[3], authors: [me]})
  });

  pool.on('notice', (relay, notice) => {
    console.log(`Notice ${relay.url}: ${notice}`)
  });

  pool.on('close', (relay, e) => {
    // console.log(`Close ${relay.url}: Code ${e.code} ${e.reason}`)
  });
  
  pool.on('error', (relay, e) => {
    console.log(`Error ${relay.url}: ${e.message}`)
  });
  
  pool.on('eose', (relay, sub_id) => {
    // console.log(`EOSE ${relay.url}`)
  });
  
  pool.on('event', (relay, sub_id, event) => {
    if (event.content && event.content.length > 0) {
      for (let [relay, state] of Object.entries(JSON.parse(event.content))) {
        if (!content[relay]) {
          content[relay] = state
        }
      }
    }
    
    let count = 0
    for (let tag of event.tags) {
      let pubkey = tag[1]
      if (!follows.includes(pubkey)) {
        count++
        follows.push(pubkey)
        let entry = {pubkey: pubkey}
        if (tag.length > 2) {
          entry.relay = tag[2]
          entry.created_at = event.created_at
        }
        entries[pubkey] = entry
      } else {
        let entry = entries[pubkey]
        if (tag.length > 2) {
          let relay = tag[2]
          if (!entry.relay) {
            entry.relay = relay
          } else {
            if (entry.created_at < event.created_at) {
              entry.created_at = event.created_at
              entry.relay = relay
            }
          }
        }
      }
    }

    console.log(`Found ${event.tags.length} tags on ${relay.url}, added ${count}`)
  });

  setInterval(() => pool.relays.forEach(relay => {if (relay.ws && relay.ws.readyState === WebSocket.OPEN) relay.ws.ping()}), 10000)

  setTimeout(async () => {

    console.log(`Found ${follows.length} tags`)
    console.log(`Found ${Object.keys(content).length} relays`)

    let event = {
      pubkey: me,
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(content)
    }

    for (let pubkey of follows) {
      let entry = entries[pubkey]
      if (entry.relay) {
        event.tags.push(['p', entry.pubkey, entry.relay])
      } else {
        event.tags.push(['p', entry.pubkey])
      }
    }

    event.id = await calculateId(event)

    if (!process.env.PRIVKEY) {

      console.log(JSON.stringify(event))
      process.exit(0)

    } else {

      event.sig = await signId(process.env.PRIVKEY, event.id)
  
      console.log(JSON.stringify(event))
  
      let writeRelays = []
      for (let [relay, stats] of Object.entries(content)) {
        if (opened.includes(relay) && stats.write) {
          writeRelays.push(relay)
        }
      }
  
      for (let relay of pool.relays) {
        if (writeRelays.includes(relay.url) && relay.ws && relay.ws.readyState === 1) {
          console.log(`Sending to ${relay.url}`)
          await relay.send(["EVENT", event])
        }
      }
      
      // Wait a bit for responses
      setTimeout(() => {
        console.log(`finished`)

        process.exit(0)
      }, 10000) 
    }
  }, 30000)
}

function npubtopubkey(npub) {
  if (!npub.startsWith('npub') || npub.length < 60) return null
  let decoded = bech32.fromWords( bech32.decode( npub ).words );
  return buffer.Buffer.from( decoded ).toString( 'hex' )
}
