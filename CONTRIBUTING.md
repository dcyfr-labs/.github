# Contributing to DCYFR Labs projects

Thanks for taking a look. This is the default guide for every repository in
[dcyfr-labs](https://github.com/dcyfr-labs). A repository with its own
`CONTRIBUTING.md` overrides this file, so read that one first if it exists.

## Ways to help

- **Report a bug.** Open an issue with the bug template. A minimal reproduction
  (the command you ran, what you expected, what happened) gets it fixed fastest.
- **Suggest a feature.** Open an issue with the feature template and describe
  the problem before the solution.
- **Fix docs.** Typos, broken links and wrong commands can go straight to a pull
  request.
- **Send code.** For anything larger than a small fix, open an issue first so we
  can agree on the approach before you spend time on it.

Issues labelled `good first issue` are scoped for a first contribution.

## Pull requests

1. Fork the repository and branch from `main`.
2. Keep each pull request to one change.
3. Add or update tests for behaviour you change.
4. Run the repository's checks locally. Most repositories use `npm ci`, then
   `npm test`, `npm run lint` and `npm run build`; the README lists the exact
   commands.
5. Title the pull request as a [conventional commit](https://www.conventionalcommits.org/),
   for example `fix(cli): handle an empty config file`. Several repositories
   cut releases from the title, so the prefix matters.

A maintainer reviews every pull request. CI must be green before merge.

## Code of conduct

The [DCYFR Labs code of conduct](CODE_OF_CONDUCT.md) applies in every
repository, issue and discussion.

## Security issues

Do not report vulnerabilities in public issues. See the
[security policy](SECURITY.md).

## Licensing

Each repository states its license in its `LICENSE` file. Unless a repository
says otherwise, your contribution is licensed under that repository's license,
as [GitHub's Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)
describe. Some repositories (Atrium, for example) also ask you to sign off your
commits; their own `CONTRIBUTING.md` says so.

"DCYFR" is a trademark of Drew Gowan. Please don't use it in a way that implies
DCYFR Labs endorses your project.
