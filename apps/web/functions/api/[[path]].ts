interface PagesEnvironment {
  NEWS_API: {
    fetch(request: Request): Promise<Response>;
  };
}

interface PagesContext {
  request: Request;
  env: PagesEnvironment;
}

export const onRequest = ({ request, env }: PagesContext): Promise<Response> =>
  env.NEWS_API.fetch(request);
