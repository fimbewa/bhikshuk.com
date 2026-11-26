# bhikshuk.com

The Immortal Love: the website of Bhikshuk in the Mahanubhav Dharma, with an owner page at **bhikshuk.com/admin** for writing posts from a phone. Same look as qindiaglobal.com.

- No outside packages. `server.js` is the whole website. `public/` holds the look (`site.css`) and the owner page (`admin.html`, `admin.js`).
- All pages, posts and settings are saved in one file, `content.json`, in the `/data` folder (Docker volume `site_data`). Photos are in `/data/media`. A copy of `content.json` is kept every day in `/data/backups` (30 days).
- `seed/content.json` is the starting content (all pages and posts from the old site), used only the first time.

## Owner page

Open `/admin` and log in. The first password is printed once in the container's log: Docker Manager → bhikshuk → **site** container → Logs → `OWNER PANEL PASSWORD`. Change it under Settings.

Writing a post: empty line = new paragraph, `## ` = heading, `- ` = list, a YouTube link alone on a line = video, **Add photo** puts a photo in.

## Running on the VPS

Docker Manager project `bhikshuk` with `docker-compose.yml`. The container downloads this repository and starts. It checks GitHub every 5 minutes and restarts itself to pick up new code; your content is not touched.

The qindiaglobal Caddy server forwards bhikshuk.com, www.bhikshuk.com and srv2172224.hstgr.cloud to this container (`bhikshuk-wp:80` on the `bhikshuk_net` network). That route was added live, without restarting qindiaglobal. After a VPS reboot, run these three commands in the Web console to add it again:

```
docker network connect bhikshuk_net qindiaglobal-web-1
docker exec qindiaglobal-web-1 sh -c 'cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile2; printf "bhikshuk.com, www.bhikshuk.com, srv2172224.hstgr.cloud {\nreverse_proxy bhikshuk-wp:80\n}\n" >> /etc/caddy/Caddyfile2'
docker exec qindiaglobal-web-1 caddy reload --config /etc/caddy/Caddyfile2 --adapter caddyfile
```

Local test: `DATA_DIR=./data PORT=3000 node server.js`
