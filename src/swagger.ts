import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { Router } from "express";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "PayCore API",
      version: "1.0.0",
      description: "PayCore payment engine backend API documentation",
    },

    // Inside src/swagger.ts, find the `servers` array and update it to this:
    servers: [
      {
        url: "http://localhost:3000/api",
        description: "Local development server",
      },
      {
        url: "https://paycore-lvs4.onrender.com/api",
        description: "Render production server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            'Enter your JWT token here (without "Bearer " prefix, Swagger adds it automatically)',
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "invalid_credentials" },
                message: {
                  type: "string",
                  example: "Invalid email or password",
                },
              },
            },
          },
        },
      },
    },
  },
  apis: ["./src/routes/*.ts"],
};

const swaggerSpec = swaggerJsdoc(options);
const router = Router();

router.use("/", swaggerUi.serve);
router.get(
  "/",
  swaggerUi.setup(swaggerSpec, {
    explorer: true,
    customCss: ".swagger-ui .topbar { display: none }",
  }),
);

export const swaggerRouter = router;
