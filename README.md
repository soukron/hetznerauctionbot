# Notifier
## Description
This is the code of the part responsible of gather new data from Hetzner and publish it to a Telegram channel using a bot account.

Join to [Hetzner Auction Servers] Telegram channel to get notified about the latest servers available for ordering.


## Configuration
The bot uses environment variables to change some settings:
- *TELEGRAM_KEY*. Is the API key of the bot account. Required.
- *TELEGRAM_CHATID*. Is the chat identifier of the channel where the bot must send the messages. Required.
- *LOGLEVEL*. Sets the verbosity (info, error or debug). Default: _info_.
- *TIMEOUT*. Sets the interval in seconds to check new servers in the remote list. Default: _60_.

## Basic Usage
```
$ npm install
$ TELEGRAM_KEY=<telegram_key> TELEGRAM_CHATID=<telegram_chatid> npm start
```

## Deploy in OpenShift
- Create a project.
  ```
  $ oc new-project hetznerauctionbot
  ```
- Edit the secret file with your own Telegram API key and the Telegram chatID of the channel where to write the messages.
  ```
  $ cp deploy/telegram-config-secret-sample.yaml deploy/telegram-config-secret.yaml 
  $ nano deploy/telegram-config-secret.yaml 
  ```
- Create the secret.
  ```
  $ oc create -f deploy/telegram-config-secret.yaml
  ```
- Create the rest of resources (an ImageStream, a BuildConfig and a DeploymentConfig) and build the image
  ```
  $ oc create -f deploy/hetznerauctionbot-notifier.yaml
  $ oc start-build notifier
  ```

## Contact
Reach me in [Twitter] or email in soukron _at_ gmbros.net

## License
Everything in this repo is licensed under GNU GPLv3 license. You can read the document [here].

[Hetzner Auction Servers]:https://t.me/hetznerauctionservers
[Twitter]:http://twitter.com/soukron
[here]:http://gnu.org/licenses/gpl.html


