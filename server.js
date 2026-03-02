require("dotenv").config();
const express = require("express");
const { Storage } = require("@google-cloud/storage");
const storage = new Storage();
const bucket = storage.bucket("launchstem-learn");
const multer = require("multer");
const { MongoClient, ObjectId } = require("mongodb");
const app = express();

app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

MongoClient.connect(process.env.CONNECTION_STRING)
  .then((client) => {
    app.locals.db = client.db("learn");
    app.listen(4000, () => {
      console.log(`Listening on port 4000...`);
    });
  })
  .catch((err) => console.log(err));

app.get("/", (req, res) => {
  res.json({ message: "Hello world" });
});

app.post("/courses", (req, res) => {
  db = app.locals.db;
  let courseWithTimestamp = {
    ...req.body,
    contentlist: [],
    createdAt: new Date(),
  };
  db.collection("courses")
    .insertOne(courseWithTimestamp)
    .then((result) => {
      courseWithTimestamp._id = result.insertedId;
      res.json(courseWithTimestamp);
    });
});

app.get("/courses", (req, res) => {
  db = app.locals.db;
  db.collection("courses")
    .find()
    .toArray()
    .then((courses) => res.json(courses));
});

app.patch("/courses/:id", (req, res) => {
  db = app.locals.db;
  db.collection("courses").updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: req.body },
  );
  res.send("Course updated");
});

// app.delete("/courses/:id", (req, res) => {
//   db = app.locals.db;
//   db.collection("courses").deleteOne({ _id: new ObjectId(req.params.id) });
//   res.send("Course deleted");
// });

app.delete("/courses/:id", async (req, res) => {
  const db = app.locals.db;
  const courseId = req.params.id;

  try {
    // 1. Delete all files in the GCS folder named after the courseId
    // This looks for any file starting with "courseId/"
    await bucket.deleteFiles({
      prefix: `${courseId}/`,
    });
    console.log(`Deleted all files in GCS folder: ${courseId}/`);

    // 2. Delete the course record from MongoDB
    const result = await db.collection("courses").deleteOne({
      _id: new ObjectId(courseId),
    });

    if (result.deletedCount === 0) {
      return res.status(404).send("Course not found in database");
    }

    res.send("Course and all associated files deleted");
  } catch (error) {
    console.error("Error during full course deletion:", error);
    res.status(500).send("Failed to delete course: " + error.message);
  }
});

app.post("/courses/:id/content", upload.single("pdfFile"), async (req, res) => {
  const db = app.locals.db;
  const courseId = req.params.id;

  try {
    let newContentItem = {};

    // CASE 1: It's a Lesson (File Upload)
    if (req.file) {
      const gcsFileName = `${courseId}/${Date.now()}-${req.file.originalname}`;
      const blob = bucket.file(gcsFileName);

      // Create the upload stream
      const blobStream = blob.createWriteStream({
        resumable: false,
        contentType: req.file.mimetype,
        // public: true,
      });

      // Wrap the stream in a Promise to keep the flow clean
      await new Promise((resolve, reject) => {
        blobStream.on("error", reject);
        blobStream.on("finish", () => {
          newContentItem = {
            title: req.body.title,
            type: "lesson",
            pdfUrl: `https://storage.googleapis.com/${bucket.name}/${blob.name}`,
            createdAt: new Date(),
          };
          resolve();
        });
        blobStream.end(req.file.buffer);
      });
    }
    // CASE 2: It's a Quiz (JSON)
    else {
      newContentItem = {
        title: req.body.title,
        type: req.body.type,
        content: req.body.content,
        createdAt: new Date(),
      };
    }

    // UPDATE MONGODB (Works for both cases)
    // 1. Get the current course to determine the next ID
    const course = await db
      .collection("courses")
      .findOne({ _id: new ObjectId(courseId) });
    if (!course) return res.status(404).json({ error: "Course not found" });

    newContentItem.id = (course.contentlist || []).length;

    // 2. Push the new item
    const result = await db
      .collection("courses")
      .findOneAndUpdate(
        { _id: new ObjectId(courseId) },
        { $push: { contentlist: newContentItem } },
        { returnDocument: "after" },
      );

    res.json(result.contentlist);
  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.delete("/courses/:id/content/:contentid", async (req, res) => {
  const db = app.locals.db;
  const courseId = req.params.id;
  const contentId = parseInt(req.params.contentid);

  try {
    // 1. Fetch the course
    const course = await db
      .collection("courses")
      .findOne({ _id: new ObjectId(courseId) });
    if (!course) return res.status(404).send("Course not found");

    // 2. Identify the specific item to delete
    const itemToDelete = course.contentlist.find(
      (item) => item.id === contentId,
    );

    // 3. If it's a lesson with a PDF, delete it from GCP
    if (itemToDelete?.type === "lesson" && itemToDelete?.pdfUrl) {
      try {
        const urlParts = itemToDelete.pdfUrl.split("/");
        // urlParts looks like ["https:", "", "storage.googleapis.com", "bucket", "folder", "file.pdf"]
        // We need the last two: folder/file.pdf
        const fileName = urlParts.slice(-2).join("/");

        await bucket.file(fileName).delete();
        console.log(`Successfully deleted GCP file: ${fileName}`);
      } catch (gcpError) {
        console.error(
          "GCP File deletion skipped (already deleted or error):",
          gcpError.message,
        );
      }
    }

    // 4. Update the array locally: filter and re-index
    const updatedContentList = course.contentlist
      .filter((item) => item.id !== contentId)
      .map((item, index) => ({
        ...item,
        id: index, // Maintain your sequential indexing
      }));

    // 5. Save the updated list back to Mongo
    await db
      .collection("courses")
      .updateOne(
        { _id: new ObjectId(courseId) },
        { $set: { contentlist: updatedContentList } },
      );

    res.send("Content and associated files deleted, IDs reordered");
  } catch (error) {
    console.error("Server error during deletion:", error);
    res.status(500).send("Error deleting content: " + error.message);
  }
});

app.patch("/courses/:id/content/reorder", (req, res) => {
  db = app.locals.db;
  // req.body should contain ordered array of content ids
  const { newOrder } = req.body;

  db.collection("courses")
    .findOne({ _id: new ObjectId(req.params.id) })
    .then((course) => {
      // Create a map of id to content for easy lookup
      const contentMap = course.contentlist.reduce((map, content) => {
        map[content.id] = content;
        return map;
      }, {});

      // Create new content list based on new order
      let contentlist = newOrder.map((id, index) => ({
        ...contentMap[id],
        id: index, // Update id to match new position
      }));

      // Update the course with reordered content
      return db
        .collection("courses")
        .updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { contentlist: contentlist } },
        )
        .then(() => contentlist); // Return the contentlist for the next then block
    })
    .then((contentlist) => {
      res.json(contentlist); // Send back the reordered contentlist
    })
    .catch((error) => {
      res.status(500).send("Error reordering content: " + error.message);
    });
});

// app.patch("/courses/:id/content/:contentid", (req, res) => {
//   db = app.locals.db;
//   db.collection("courses")
//     .findOne({ _id: new ObjectId(req.params.id) })
//     .then((course) => {
//       // Find the index of content to update
//       const contentIndex = course.contentlist.findIndex(
//         (content) => content.id === parseInt(req.params.contentid),
//       );
//       if (contentIndex === -1) {
//         return res.status(404).json({ error: "Content not found" });
//       }

//       // Update only the properties passed in request body, preserving id and other properties
//       course.contentlist[contentIndex] = {
//         ...course.contentlist[contentIndex],
//         ...req.body,
//       };

//       // Save the updated course
//       return db
//         .collection("courses")
//         .updateOne(
//           { _id: new ObjectId(req.params.id) },
//           { $set: { contentlist: course.contentlist } },
//         );
//     })
//     .then(() => {
//       res.send("Content updated");
//     });
// });

app.patch(
  "/courses/:id/content/:contentid",
  upload.single("pdfFile"),
  async (req, res) => {
    const db = app.locals.db;
    const { id, contentid } = req.params;

    try {
      const course = await db
        .collection("courses")
        .findOne({ _id: new ObjectId(id) });
      if (!course) return res.status(404).json({ error: "Course not found" });

      const contentIndex = course.contentlist.findIndex(
        (c) => c.id === parseInt(contentid),
      );
      if (contentIndex === -1)
        return res.status(404).json({ error: "Content not found" });

      let updatedItem = { ...course.contentlist[contentIndex] };

      // --- CASE 1: Updating a PDF Lesson ---
      if (req.file) {
        // 1. Delete old file if it exists
        if (updatedItem.pdfUrl) {
          try {
            const oldFileName = updatedItem.pdfUrl
              .split("/")
              .slice(-2)
              .join("/");
            await bucket.file(oldFileName).delete();
          } catch (e) {
            console.log("Old file not found in bucket, skipping delete.");
          }
        }

        // 2. Upload new file
        const gcsFileName = `${id}/${Date.now()}-${req.file.originalname}`;
        const blob = bucket.file(gcsFileName);
        const blobStream = blob.createWriteStream({
          resumable: false,
          contentType: req.file.mimetype,
        });

        await new Promise((resolve, reject) => {
          blobStream.on("error", reject);
          blobStream.on("finish", () => {
            updatedItem.pdfUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
            resolve();
          });
          blobStream.end(req.file.buffer);
        });
      }
      // --- CASE 2: Updating a Quiz (JSON) ---
      else if (req.body.content) {
        updatedItem.content = req.body.content;
      }

      // Update the array and save
      course.contentlist[contentIndex] = updatedItem;
      await db
        .collection("courses")
        .updateOne(
          { _id: new ObjectId(id) },
          { $set: { contentlist: course.contentlist } },
        );

      res.json(course.contentlist);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);
