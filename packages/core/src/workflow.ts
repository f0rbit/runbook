import type { z } from "zod";
import type {
	MapperFn,
	ParallelOutputTuple,
	ParallelStepDef,
	Step,
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

				return {
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
								run: async () => {
									throw new Error("Sub-workflow steps must be executed through the engine");
								},
							},
						};
					},
				};
			},
		};
	}

	return createBuilder<WI>();
}
