# AllByte Studios

Web portal for AllByte Studios — an indie game studio building The Chronicles of Nesis, a tactical turn-based RPG.

**Live site:** [allbyte.studio](https://allbyte.studio)

## Stack

- **Astro 6** + **Svelte 5** + **Tailwind CSS v4**
- Hosted on **AWS S3 + CloudFront**
- CI/CD via **GitHub Actions** with OIDC (no stored secrets)
- Infrastructure defined in a single **CloudFormation** template

## Development

```bash
npm install
npm run dev       # localhost:4321
npm run build     # production build
```

## Deployment

Every push to `main` auto-deploys to [allbyte.studio](https://allbyte.studio). See the [Self-Hosting with Claude](https://allbyte.studio/self-hosting-with-claude) page for the full setup guide, cost breakdown, and architecture details.

## License

ISC
