import { ToolContext, ToolDescriptor, ToolRoute } from "./types.js";
import { ToolRouter } from "./ToolRouter.js";

export class ContextAwareDispatcher {
  private readonly router: ToolRouter;

  constructor(tools: ToolDescriptor[]) {
    this.router = new ToolRouter(tools);
  }

  dispatch(context: ToolContext): ToolRoute {
    const route = this.router.route(context);
    if (!route) {
      throw new Error(`No suitable tool found for goal: ${context.goal}`);
    }

    return route;
  }
}
