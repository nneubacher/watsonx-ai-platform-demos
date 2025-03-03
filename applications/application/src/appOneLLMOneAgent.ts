/**
 * Copyright 2024 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { readFileSync } from 'fs';
import "dotenv/config.js";
import { BeeAgent } from "bee-agent-framework/agents/bee/agent";
import { createConsoleReader } from "./io.js";
import { FrameworkError } from "bee-agent-framework/errors";
import { Logger } from "bee-agent-framework/logger/logger";
import { UnconstrainedMemory } from "bee-agent-framework/memory/unconstrainedMemory";
import { WatsonxChatModel } from "bee-agent-framework/adapters/watsonx/backend/chat";
import { RouterUpdateTool } from './toolRouterUpdate.js';
import { WriteMailTool } from './toolWriteMail.js';
import { generateSummary } from './llmSummarizeTranscript.js';
import { z } from "zod";

const instructionFileLLM = './prompts/instructionLLM.md'
const instructionFileAgent = './prompts/instructionOneAgent.md'
const transcriptFile = './prompts/prompt4.md'
const reader = createConsoleReader();
const logger = new Logger({ name: "app", level: "trace" });
const instructionLLM = readFileSync(instructionFileLLM, 'utf-8').split("\\n").join("\n")
let promptInput:string = readFileSync(transcriptFile, 'utf-8').split("\\n").join("\n")
let prompt:string = instructionLLM + "\n\n" + promptInput
console.log("Transcript:")
console.log(prompt)

//////////////////////////////////////////////////////////////////
// Step 1: LLM summarization
//////////////////////////////////////////////////////////////////

let transcript:string = readFileSync(transcriptFile, 'utf-8').split("\\n").join("\n")
const llmResponse = await generateSummary(transcript)
if (!llmResponse) {
  console.error("❌ Transcript Summary Generation Failed: No response received.");
  process.exit(1);
}
let llmStep1Response = llmResponse?.getTextContent()
reader.write(`LLM 🤖 (text) : `, llmStep1Response);

//////////////////////////////////////////////////////////////////
// Step 2 and 3: One Agent with RouterUpdateTool and WriteMailTool
//////////////////////////////////////////////////////////////////

const chatLLM = new WatsonxChatModel("meta-llama/llama-3-1-70b-instruct")

const agent = new BeeAgent({
    llm: chatLLM,
    memory: new UnconstrainedMemory(),
    templates: {
        user: (template) => 
            template.fork((config) => {
                config.schema = z.object({ input: z.string()}).passthrough();
                config.template = '{(input)}';
            })
    },
    tools: [
        new WriteMailTool(),
        new RouterUpdateTool()
    ]
});

const instructionOneAgent = readFileSync(instructionFileAgent, 'utf-8').split("\\n").join("\n")
prompt = instructionOneAgent + llmStep1Response
try {
  console.log("Prompt:")
  console.log(prompt)

  const response = await agent
    .run(
      { prompt },
      {
        execution: {
          maxRetriesPerStep: 5,
          totalMaxRetries: 5,
          maxIterations: 5,
        },
      },
    )
    .observe((emitter) => {
      emitter.on("start", () => {
        reader.write(`Agent 🤖 : `, "starting new iteration");
      });
      emitter.on("error", ({ error }) => {
        reader.write(`Agent 🤖 : `, FrameworkError.ensure(error).dump());
      });
      emitter.on("retry", () => {
        reader.write(`Agent 🤖 : `, "retrying the action...");
      });
      emitter.on("update", async ({ data, update, meta }) => {
        reader.write(`Agent (${update.key}) 🤖 : `, update.value);
      });
      emitter.match("*.*", async (data: any, event) => {
        if (event.creator === chatLLM) {
          const eventName = event.name;
          switch (eventName) {
            case "start":
              console.info("LLM Input");
              console.info(data.input);
              break;
            case "success":
              console.info("LLM Output");
              console.info(data.value.raw.finalResult);
              break;
            case "error":
              console.error(data);
              break;
          }
        }
      });
    });
    reader.write(`Agent 🤖 : `, response.result.text);
} catch (error) {
  logger.error(FrameworkError.ensure(error).dump());
} finally {
  process.exit(0);
}