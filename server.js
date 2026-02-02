require("dotenv").config();
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const app = express();

app.use(express.json());

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

app.delete("/courses/:id", (req, res) => {
  db = app.locals.db;
  db.collection("courses").deleteOne({ _id: new ObjectId(req.params.id) });
  res.send("Course deleted");
});

app.post("/courses/:id/content", (req, res) => {
  db = app.locals.db;
  db.collection("courses")
    .findOne({ _id: new ObjectId(req.params.id) })
    .then((course) => {
      if (!course) {
        return res.status(404).json({ error: "Course not found" });
      }

      if (!course.contentlist) {
        course.contentlist = [];
      }

      const nextId = course.contentlist.length;
      const contentWithId = {
        id: nextId,
        ...req.body,
      };
      return db
        .collection("courses")
        .updateOne(
          { _id: new ObjectId(req.params.id) },
          { $push: { contentlist: contentWithId } },
        );
    })
    .then(() => {
      return db
        .collection("courses")
        .findOne({ _id: new ObjectId(req.params.id) });
    })
    .then((updatedCourse) => {
      res.json(updatedCourse.contentlist);
    })
    .catch((err) => {
      res.status(500).json({ error: err.message });
    });
});

app.delete("/courses/:id/content/:contentid", (req, res) => {
  db = app.locals.db;
  db.collection("courses")
    .findOne({ _id: new ObjectId(req.params.id) })
    .then((course) => {
      // Remove the content
      course.contentlist = course.contentlist.filter(
        (content) => content.id !== parseInt(req.params.contentid),
      );
      // Reorder remaining content ids
      course.contentlist = course.contentlist.map((content, index) => ({
        ...content,
        id: index,
      }));
      // Update the course with reordered content
      return db
        .collection("courses")
        .updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { contentlist: course.contentlist } },
        );
    })
    .then(() => {
      res.send("Content deleted and ids reordered");
    });
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

app.delete("/courses/:id/content/:contentid", (req, res) => {
  db = app.locals.db;
  db.collection("courses")
    .findOne({ _id: new ObjectId(req.params.id) })
    .then((course) => {
      // First filter out the deleted content
      course.contentlist = course.contentlist.filter(
        (content) => content.id !== parseInt(req.params.contentid),
      );

      // Readjust remaining ids to be sequential starting from 0
      course.contentlist = course.contentlist.map((content, index) => ({
        ...content,
        id: index,
      }));

      return db
        .collection("courses")
        .updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { contentlist: course.contentlist } },
        );
    })
    .then(() => {
      res.send("Content deleted and ids reordered");
    });
});

app.patch("/courses/:id/content/:contentid", (req, res) => {
  db = app.locals.db;
  db.collection("courses")
    .findOne({ _id: new ObjectId(req.params.id) })
    .then((course) => {
      // Find the index of content to update
      const contentIndex = course.contentlist.findIndex(
        (content) => content.id === parseInt(req.params.contentid),
      );
      if (contentIndex === -1) {
        return res.status(404).json({ error: "Content not found" });
      }

      // Update only the properties passed in request body, preserving id and other properties
      course.contentlist[contentIndex] = {
        ...course.contentlist[contentIndex],
        ...req.body,
      };

      // Save the updated course
      return db
        .collection("courses")
        .updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { contentlist: course.contentlist } },
        );
    })
    .then(() => {
      res.send("Content updated");
    });
});
