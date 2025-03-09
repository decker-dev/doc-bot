import type { Context } from "probot";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import axios from "axios";
import type { CustomRulesResponse, Logger } from "../types/index.js";
import { createReviewComment, getFileContent } from "../services/github.js";

const RULES_FORMATTER_PROMPT = `You are a documentation rules formatter. Your task is to convert any free-form rules or guidelines into a structured format.

Output format requirements:
1. Start with a clear description of the ruleset
2. Format each rule with a category prefix in CAPS, followed by a colon
3. Make rules specific and actionable
4. Categories should be one of: TONE, STYLE, FORMAT, BREVITY, CONTENT
5. Each rule should be in a bullet point format
6. IMPORTANT: Do not add any inferred rules or expand upon the given rules
7. Convert ONLY the explicitly stated rules, do not add any additional interpretations

Example input:
"make it sarcastic and short, use emojis when possible"

Example output:
Description: Rules for sarcastic and concise documentation
Rules:
- TONE: Use a sarcastic tone
- BREVITY: Keep it short
- STYLE: Use emojis when possible

Format the provided rules following this structure.`;

const PROMPT_BASE = `<internal_reminder>

1. <docbuddy_info>
    - DocBuddy is an advanced documentation improvement assistant.
    - DocBuddy analyzes Markdown documentation to provide improved versions.
    - DocBuddy focuses on clarity, conciseness, and technical accuracy.
    - DocBuddy maintains the original meaning while enhancing readability.
    - DocBuddy has knowledge of Markdown, documentation best practices, and technical writing.
    - DocBuddy now has a SARCASM MODE that delivers scathingly witty and hilariously condescending feedback—but remember, the sarcasm must be confined strictly to the "reason" for the change.

2. <docbuddy_capabilities>
    - Analyzes individual Markdown paragraphs to identify areas for improvement.
    - Enhances clarity without changing technical meaning.
    - Improves structure and readability of each paragraph.
    - Standardizes Markdown formatting according to best practices.
    - Provides specific and actionable suggestions for each paragraph.
    - In SARCASM MODE, the feedback should be brutally honest and sharply sarcastic in the "reason" only, while the "suggestion" remains clear and professional.

3. <docbuddy_response_format>
    - DocBuddy MUST return responses in the format: "reason: [REASON WHY THE CHANGE IS NEEDED]\nsuggestion: [IMPROVED TEXT]"
    - The "reason" should briefly explain the improvement with biting sarcasm, addressing the original text as if it were embarrassingly subpar.
    - In SARCASM MODE, the sarcasm must appear exclusively in the "reason" field, while the "suggestion" should present a clear, improved version of the text in a professional tone.
    - Both parts are required in this exact format.
    - Example:
      reason: The sentence is fragmented and unclear.
      suggestion: This is the improved, clearer version of the text.
    - SARCASM MODE Example:
      reason: Wow, did you really think that was acceptable? This sentence is so disjointed it appears to have been written in a blackout by someone who forgot what punctuation looks like.
      suggestion: This is the improved, clearer version of the text that even a beginner could understand.

4. <docbuddy_guidelines>
    - ALWAYS prioritize clarity over brevity when both conflict.
    - MAINTAIN Markdown-specific syntax and formatting.
    - PRESERVE the complete meaning of the original text.
    - IMPROVE the structure of long sentences by dividing them when appropriate.
    - ELIMINATE redundancies and superfluous text.
    - ENSURE proper Markdown formatting.
    - Make each suggestion SPECIFIC and ACTIONABLE.
    - Address the specific issues in the content while maintaining original intent.
    - Consider the CONTEXT of the entire document when making suggestions.
    - Ensure the suggestion flows naturally with surrounding content.
5. <forming_correct_responses>
    - ALWAYS follow the response format: "reason: [explanation]\nsuggestion: [improved text]"
    - Keep reasons brief but specific (1-2 sentences).
    - The suggestion part should contain ONLY the improved text.
    - If no improvements are possible, say "reason: No improvements needed." and repeat the original text in the suggestion.
    - Only the suggestion part will replace the original text.
    - Focus your suggestion ONLY on the TARGET LINE.
6. <custom_rules>
    IMPORTANT: Custom rules have the HIGHEST PRIORITY and OVERRIDE all other guidelines.
    If a custom rule conflicts with any other guideline above, the custom rule ALWAYS takes precedence.
    Note: Custom rules may be empty. If no custom rules are provided, follow only the base guidelines above.
    
    CUSTOM_RULES

</internal_reminder>

Here is the full document context (for reference only):
FULL_DOCUMENT_CONTEXT

Here is the specific line you should improve:
TARGET_LINE`;

/**
 * Analyzes a patch and generates AI-powered improvement suggestions for Markdown documentation
 */
export async function createDocumentationSuggestions(
  context: Context,
  owner: string,
  repo: string,
  pullNumber: number,
  commitId: string,
  filePath: string,
  patch: string,
  logger: Logger,
  authorEmail: string
) {
  try {
    // Parse the patch to find added or modified lines
    const lines = patch.split("\n");

    // Collect all documentation lines and their positions
    const docLines: { line: number; codeLine: string }[] = [];

    // Keep track of deleted lines (lines that start with '-')
    const deletedLineNums = new Set<number>();

    // Process each line in the patch to identify documentation
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track deleted lines
      if (line.startsWith("-") && !line.startsWith("---")) {
        // Calculate the actual line number from the patch
        const position = calculatePositionInFile(lines, i);
        deletedLineNums.add(position);
      }

      // Look for lines that start with '+' (added/modified) but not metadata lines (+++/---)
      if (line.startsWith("+") && !line.startsWith("+++")) {
        // Get the line without the '+' prefix
        const codeLine = line.substring(1);

        // Calculate the position to check if this is replacing a deleted line
        const position = calculatePositionInFile(lines, i);

        // If the line is not empty and either:
        // 1. It's a brand new line (not replacing a deleted line), or
        // 2. It's replacing a deleted line with new content
        // Then add it for processing
        if (codeLine.trim() && !deletedLineNums.has(position)) {
          // Add the line to our collection - this is a new line
          docLines.push({ line: i, codeLine });
        } else if (codeLine.trim() && deletedLineNums.has(position)) {
          // This is replacing a deleted line with new content
          docLines.push({ line: i, codeLine });
          // Remove from deleted lines set as it's now replaced
          deletedLineNums.delete(position);
        }
        // If the line is empty or just whitespace and it's replacing a deleted line,
        // we don't add it to docLines (we don't want to suggest for a deleted line)
      }
    }

    // If there are no lines to improve, exit
    if (docLines.length === 0) {
      logger.info("No documentation lines found to improve");
      return 0;
    }

    logger.info(
      `Found ${docLines.length} lines to improve in file ${filePath}`
    );

    // Try to get the full file content for context
    let fileContent: string | null = null;
    try {
      fileContent = await getFileContent(
        context,
        owner,
        repo,
        commitId,
        filePath,
        logger
      );

      if (fileContent) {
        logger.info(
          `Successfully retrieved full content of ${filePath} for context`
        );
      } else {
        logger.info(
          `Could not retrieve full content of ${filePath}, will proceed with limited context`
        );
      }
    } catch (contentError) {
      logger.error(`Error getting file content for context: ${contentError}`);
      // Continue without full context
    }

    // Create individual suggestions for each line
    let successCount = 0;

    // Process each line individually
    for (const doc of docLines) {
      try {
        // Process each line separately
        const success = await processIndividualLine(
          context,
          owner,
          repo,
          pullNumber,
          commitId,
          filePath,
          doc,
          lines,
          fileContent,
          logger,
          authorEmail
        );

        if (success) {
          successCount++;
        }
      } catch (lineError) {
        logger.error(`Error processing line: ${lineError}`);
        // Continue with next line
      }
    }

    logger.info(`Created ${successCount} individual line suggestions`);
    return successCount;
  } catch (error) {
    logger.error(`Error analyzing patch and creating suggestions: ${error}`);
    // Always return success to prevent failures
    return 0;
  }
}

/**
 * Processes a single line and generates an individual improvement suggestion
 */
async function processIndividualLine(
  context: Context,
  owner: string,
  repo: string,
  pullNumber: number,
  commitId: string,
  filePath: string,
  doc: { line: number; codeLine: string },
  lines: string[],
  fileContent: string | null,
  logger: Logger,
  authorEmail: string
): Promise<boolean> {
  try {
    // Skip empty lines
    if (!doc.codeLine.trim()) {
      return false;
    }

    // Skip lines that contain co-author metadata or suggest they were already part of a suggestion
    if (
      doc.codeLine.includes("Co-authored-by:") ||
      doc.codeLine.includes("suggestion") ||
      doc.codeLine.includes("Suggested") ||
      doc.codeLine.includes("bot@")
    ) {
      logger.info("Skipping line with suggestion metadata");
      return false;
    }

    // Skip lines with common GitHub suggestion acceptance patterns
    if (
      doc.codeLine.match(/Apply suggestion from/i) ||
      doc.codeLine.match(/Co-authored-by:/i)
    ) {
      logger.info("Skipping GitHub suggestion acceptance metadata");
      return false;
    }

    // Prepare the prompt with context if available
    let prompt = doc.codeLine;

    if (fileContent) {
      // Replace placeholders in the base prompt
      const promptWithContext = PROMPT_BASE.replace(
        "FULL_DOCUMENT_CONTEXT",
        fileContent
      ).replace("TARGET_LINE", doc.codeLine);
      prompt = promptWithContext;
    }

    try {
      logger.info(`Getting custom rules for ${authorEmail}`);
      const customRules = await axios.get<CustomRulesResponse>(
        "https://api.sheety.co/8e7fca93247a01053ea6b43066d2a3aa/customRules/data"
      );
      logger.info(`authorEmail: ${authorEmail}`);
      if (customRules?.data?.data) {
        const ownerCustomRules = customRules?.data.data.find(
          (rule) => rule.email === authorEmail
        );
        logger.info(`Owner custom rules: ${ownerCustomRules}`);
        if (ownerCustomRules?.rules) {
          const formattedRules = await formatCustomRules(
            ownerCustomRules.rules,
            logger
          );
          logger.info(`Formatted custom rules: ${formattedRules}`);
          if (formattedRules) {
            prompt = prompt.replace("CUSTOM_RULES", formattedRules);
          } else {
            prompt = prompt.replace("CUSTOM_RULES", "");
          }
        } else {
          prompt = prompt.replace("CUSTOM_RULES", "");
        }
      }
    } catch (error) {
      logger.error(`Error getting custom rules: ${error}`);
      prompt = prompt.replace("CUSTOM_RULES", "No custom rules provided.");
    }

    // Use AI to improve the line
    const { text } = await generateText({
      model: openai("gpt-4"),
      system: fileContent ? "" : PROMPT_BASE, // Only use the system prompt if we're not using context
      prompt: prompt,
    }).catch(error => {
      logger.error(`AI generation error for line: ${error}`);
      return { text: "" };
    });

    // If no improvement was generated, skip
    if (!text) {
      return false;
    }

    // Check if the response follows the expected format
    if (text.includes("reason:") && text.includes("suggestion:")) {
      // Use the formatted suggestion
      const body = formatSuggestionComment(text);

      // Calculate the position in the file
      const position = calculatePositionInFile(lines, doc.line);

      // Create a review comment for this specific line
      await createReviewComment(
        context,
        owner,
        repo,
        pullNumber,
        body,
        commitId,
        filePath,
        position,
        logger
      );

      logger.info(
        `Created individual suggestion with reason for line at position ${position}`
      );
      return true;
    }

    // If response doesn't follow the format, check if it's different from original
    if (text.trim() === doc.codeLine.trim()) {
      return false;
    }

    // Use simple suggestion format as fallback
    const body = formatLineSuggestion(doc.codeLine, text);

    // Calculate the position in the file
    const position = calculatePositionInFile(lines, doc.line);

    // Create a review comment for this specific line
    await createReviewComment(
      context,
      owner,
      repo,
      pullNumber,
      body,
      commitId,
      filePath,
      position,
      logger
    );

    logger.info(`Created simple suggestion for line at position ${position}`);
    return true;
  } catch (error) {
    logger.error(`Error processing line: ${error}`);
    return false;
  }
}

/**
 * Calculates the position in a file based on the patch
 */
function calculatePositionInFile(lines: string[], lineIndex: number): number {
  try {
    // Position calculation is tricky in GitHub's API
    // The best approximation is to use the line number from the @@ markers
    // and count from there, skipping removed lines

    let position = 1;
    let currentHunkStart = 0;
    let linesAfterHunkStart = 0;

    for (let j = 0; j < lineIndex; j++) {
      const line = lines[j];
      if (line?.startsWith("@@ ")) {
        const match = line.match(/@@ -\d+,\d+ \+(\d+),\d+ @@/);
        if (match?.[1]) {
          currentHunkStart = Number.parseInt(match[1], 10);
          linesAfterHunkStart = 0;
        }
      } else if (line?.startsWith("+")) {
        linesAfterHunkStart++;
      } else if (!line?.startsWith("-")) {
        linesAfterHunkStart++;
      }
    }

    position = currentHunkStart + linesAfterHunkStart;

    // Ensure position is at least 1
    return Math.max(position, 1);
  } catch (error) {
    // In case of any error in calculation, return a safe default
    console.error(`Error calculating file position: ${error}`);
    return 1;
  }
}

/**
 * Formats a suggestion comment that includes a reason
 */
function formatSuggestionComment(content: string): string {
  // Split the content into reason and suggestion
  const parts = content.split("\nsuggestion:");
  if (parts.length !== 2) {
    return content; // Return original content if format is not as expected
  }

  const reason = parts[0].replace("reason:", "").trim();
  const suggestion = parts[1].trim();

  return [
    `**Reason for improvement:** ${reason}`,
    "```suggestion",
    suggestion,
    "```",
  ].join("\n");
}

/**
 * Formats a simple line-specific suggestion comment without reason
 */
function formatLineSuggestion(_original: string, improved: string): string {
  return ["```suggestion", improved, "```"].join("\n");
}

/**
 * Formats custom rules into a standardized structure using AI
 */
async function formatCustomRules(
  rules: string,
  logger: Logger
): Promise<string> {
  try {
    const { text } = await generateText({
      model: openai("gpt-4"),
      system: RULES_FORMATTER_PROMPT,
      prompt: rules,
    }).catch((error) => {
      throw new Error(`Error formatting rules: ${error}`);
    });

    return text || "";
  } catch (error) {
    logger.error(`Error in formatCustomRules: ${error}`);
    return "";
  }
}
