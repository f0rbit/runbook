import { err, ok } from "@f0rbit/corpus";
import type { z } from "zod";
import { errors } from "./errors";
import type {
	MapperFn,
	ParallelOutputTuple,
	ParallelStepDef,
	Step,
	StepContext,
	StepNode,
	Workflow,
	WorkflowBuilder,
} from "./types";

export function defineWorkflow<WI>(input: z.ZodType<WI>): WorkflowBuilder<WI, WI> {
	const steps: StepNode[] = [];

	function createBuilder<LastO>(): WorkflowBuilder<WI, LastO> {
		return {
			pipe<I, O>(step: Step<I, O>, mapper: (workflow_input: WI, previous_output: LastO) => I): WorkflowBuilder<WI, O> {
				steps.push({ type: "sequential", step, mapper: mapper as MapperFn });
				return createBuilder<O>();
			},

			parallel<T extends readonly ParallelStepDef<WI, LastO, any, any>[]>(
				...defs: T
			): WorkflowBuilder<WI, ParallelOutputTuple<T>> {
				const branches = defs.map(([step, mapper]) => ({ step, mapper: mapper as MapperFn }));
				steps.push({ type: "parallel", branches });
				return createBuilder<ParallelOutputTuple<T>>();
			},

			done(id: string, output: z.ZodType<LastO>): Workflow<WI, LastO> {
				const frozen_steps = [...steps];

				const workflow: Workflow<WI, LastO> = {
					id,
					input,
					output,
					steps: frozen_steps,
					asStep(): Step<WI, LastO> {
						return {
							id,
							input,
							output,
							kind: {
								kind: "fn",
								run: async (step_input: WI, ctx: StepContext) => {
									const result = await ctx.engine.run(workflow, step_input);
									if (!result.ok) {
										return err(errors.execution(id, `Sub-workflow '${id}' failed: ${result.error.kind}`));
									}
									return ok(result.value.output);
								},
							},
						};
					},
				};

				return workflow;
			},
		};
	}

	return createBuilder<WI>();
}
