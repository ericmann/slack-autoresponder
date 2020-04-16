# Slack Autoresponder
Serverless application for automatically replying to Slack DMs.

Read the following blog posts to understand the motivation behind this project and walk through various steps to install the required frameworks and set up the project:

- https://ttmm.io/tech/slack-autoresponder-1/
- https://ttmm.io/tech/slack-autoresponder-2/

## Setup

Once you have the Serverless framework installed and your AWS credentials configured, you'll need to:
- Either create an AWS profile named `eamann` or edit the profile identifier in `serverless.yml`
- Create a `secrets.yml` that copies `_secrets.yml` and populates the necessary credentials

Then you can deploy your autoresponder with `sls deploy` and enjoy the automated Slack responses.